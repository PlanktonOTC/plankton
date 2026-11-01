// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {DelayedUpgrade} from "./DelayedUpgrade.sol";
import {MarketState, MarketConfig, Market, PendingMarket, Position, Trade, State} from "./ExchangeTypes.sol";
import {ExchangeLib} from "./ExchangeLib.sol";
import {ExchangeMath as M} from "./ExchangeMath.sol";
import {MarketConfigLib} from "./MarketConfigLib.sol";
import {
    IMarkOracle,
    ICounterVault,
    IExchangeCounterView,
    IPayoutDesk,
    IBackstopFund,
    IFirstLossTranche,
    IFeeRouter
} from "./interfaces/Interfaces.sol";

/// @notice Perpetuals against the Counter. Traders hold isolated USDG margin per market.
/// Price comes from the signed MarkOracle; execution price comes from an off-chain signed quote that the
/// contract bounds (deviation from the mark, never better than the skew-impact price, fee range).
/// Exits are never blocked: reduces work in every state, and `closeAtMark` needs no backend at all.
///
/// This contract authenticates and routes. The trade engine lives in ExchangeLib and MarketConfigLib, linked libraries
/// that run on this contract's storage (this keeps it under the 24 KB size limit). Deploy with both libraries linked.
contract Exchange is IExchangeCounterView, EIP712Upgradeable, DelayedUpgrade {
    using SafeERC20 for IERC20;

    struct TradeQuote {
        bytes32 marketId;
        address trader;
        int256 sizeDeltaE18;
        uint256 execPriceE18;
        uint256 feeUsdg;
        uint64 maxLeverageE18;
        uint64 markSequence;
        uint64 nonce;
        uint64 expiry;
    }

    struct Order {
        bytes32 marketId;
        address trader;
        uint8 kind; // 0 limit, 1 stop, 2 take-profit, 3 stop-loss, 4 TWAP slice
        int256 sizeDeltaE18;
        uint16 sizeBps; // when non-zero: reduce by this share of the position instead of sizeDeltaE18
        uint256 triggerE18;
        bool triggerAbove;
        bool reduceOnly;
        uint16 maxSlippageBps;
        uint128 marginUsdg;
        uint64 validAfter;
        uint64 expiry;
        uint64 nonce;
    }

    struct Deps {
        IERC20 usdg;
        IMarkOracle oracle;
        ICounterVault vault;
        IBackstopFund backstop;
        IFirstLossTranche firstLoss;
        IFeeRouter feeRouter;
        IPayoutDesk payoutDesk;
    }

    uint256 public constant MAX_MARKETS = 64;
    uint256 public constant CHANGE_DELAY = 24 hours;
    uint8 public constant MAX_QUOTE_SIGNERS = 3;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 execPriceE18,uint256 feeUsdg,uint64 maxLeverageE18,uint64 markSequence,uint64 nonce,uint64 expiry)"
    );
    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(bytes32 marketId,address trader,uint8 kind,int256 sizeDeltaE18,uint16 sizeBps,uint256 triggerE18,bool triggerAbove,bool reduceOnly,uint16 maxSlippageBps,uint128 marginUsdg,uint64 validAfter,uint64 expiry,uint64 nonce)"
    );

    State internal s;
    address public guardian;

    mapping(address => bool) public isQuoteSigner;
    uint8 public quoteSignerCount;
    mapping(address => uint64) public quoteSignerActivatesAt;

    mapping(address => mapping(uint64 => bool)) public usedQuoteNonce;
    mapping(address => uint64) public quoteNonceFloor;
    mapping(address => mapping(uint64 => bool)) public usedOrderNonce;
    mapping(address => uint64) public orderNonceFloor;

    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount);
    event MarketScheduled(bytes32 indexed marketId, uint64 effectiveAt, bool loosening);
    event MarketStateChanged(bytes32 indexed marketId, MarketState state);
    event OrderCancelled(address indexed trader, uint64 nonce);
    event QuoteSignerChanged(address indexed signer, bool allowed, uint64 effectiveAt);
    event GuardianChanged(address indexed guardian);
    event ReferrerSet(address indexed trader, address indexed referrer);

    error UnknownMarket();
    error NoMark();
    error WrongTrader();
    error QuoteExpired();
    error NonceUsed();
    error BadSigner();
    error OrderNotActive();
    error OrderMismatch();
    error TriggerNotMet();
    error NotReducing();
    error Slippage();
    error InsufficientCollateral();
    error NoPosition();
    error OracleNotConfigured();
    error TooManyMarkets();
    error NothingPending();
    error TooEarly();
    error NotGuardian();
    error BadState();
    error SignerLimit();
    error AlreadySigner();
    error ZeroAddress();
    error AlreadySet();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, Deps calldata d, address[] calldata quoteSigners) external initializer {
        __EIP712_init("PlanktonExchange", "1");
        __DelayedUpgrade_init(owner_);
        if (
            address(d.usdg) == address(0) || address(d.oracle) == address(0) || address(d.vault) == address(0)
                || address(d.backstop) == address(0) || address(d.firstLoss) == address(0)
                || address(d.feeRouter) == address(0) || address(d.payoutDesk) == address(0)
        ) revert ZeroAddress();
        s.usdg = d.usdg;
        s.oracle = d.oracle;
        s.vault = d.vault;
        s.backstop = d.backstop;
        s.firstLoss = d.firstLoss;
        s.feeRouter = d.feeRouter;
        s.payoutDesk = d.payoutDesk;
        d.usdg.forceApprove(address(d.feeRouter), type(uint256).max);
        for (uint256 i; i < quoteSigners.length; ++i) {
            if (quoteSigners[i] == address(0) || isQuoteSigner[quoteSigners[i]]) revert AlreadySigner();
            if (quoteSignerCount == MAX_QUOTE_SIGNERS) revert SignerLimit();
            isQuoteSigner[quoteSigners[i]] = true;
            ++quoteSignerCount;
        }
    }

    // ------------------------------------------------------------------ collateral account

    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 sig_s) external {
        _permit(amount, deadline, v, r, sig_s);
        _deposit(msg.sender, amount);
    }

    /// Free collateral only. Never paused.
    function withdraw(uint256 amount) external {
        if (amount > s.collateral[msg.sender]) revert InsufficientCollateral();
        s.collateral[msg.sender] -= amount;
        s.usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function addMargin(bytes32 marketId, uint128 amount) external {
        Position storage p = s.positions[msg.sender][marketId];
        if (p.size == 0) revert NoPosition();
        if (amount > s.collateral[msg.sender]) revert InsufficientCollateral();
        s.collateral[msg.sender] -= amount;
        p.margin += amount;
        s.markets[marketId].marginTotal += amount;
        emit ExchangeLib.PositionUpdated(msg.sender, marketId, p.size, p.entry, p.margin);
    }

    // ------------------------------------------------------------------ trading

    function execute(TradeQuote calldata q, bytes calldata quoteSig, uint128 marginUsdg) external {
        _execute(msg.sender, q, quoteSig, marginUsdg, 0);
    }

    /// One transaction: permit, deposit and trade. A front-run permit does not block it.
    function permitAndExecute(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 sig_s,
        TradeQuote calldata q,
        bytes calldata quoteSig,
        uint128 marginUsdg
    ) external {
        _permit(amount, deadline, v, r, sig_s);
        _deposit(msg.sender, amount);
        _execute(msg.sender, q, quoteSig, marginUsdg, 0);
    }

    /// One transaction: trade, then withdraw all free collateral.
    function executeAndWithdraw(TradeQuote calldata q, bytes calldata quoteSig) external {
        _execute(msg.sender, q, quoteSig, 0, 0);
        uint256 bal = s.collateral[msg.sender];
        if (bal > 0) {
            s.collateral[msg.sender] = 0;
            s.usdg.safeTransfer(msg.sender, bal);
            emit Withdrawn(msg.sender, bal);
        }
    }

    /// Permissionless exit for the caller's own position. No quote, no backend. See ExchangeLib.closeAtMark.
    function closeAtMark(bytes32 marketId, uint16 sizeBps) external {
        ExchangeLib.closeAtMark(s, msg.sender, marketId, sizeBps);
    }

    // ------------------------------------------------------------------ trigger orders

    /// Any keeper may execute a trader-signed order once its trigger is met. The trader's signature binds
    /// the market, size, trigger, slippage and margin; the quote binds the price.
    function executeOrder(Order calldata o, bytes calldata traderSig, TradeQuote calldata q, bytes calldata quoteSig)
        external
    {
        // EOA or smart-contract wallet (ERC-1271).
        if (!SignatureChecker.isValidSignatureNow(o.trader, _hashOrder(o), traderSig)) revert BadSigner();
        if (block.timestamp < o.validAfter || block.timestamp > o.expiry) revert OrderNotActive();
        // A take-profit or stop-loss belongs to the position it was placed on. Once that position has closed, it must
        // not fire on a later one in the same market.
        if ((o.reduceOnly || o.sizeBps > 0) && o.validAfter <= s.closedAt[o.trader][o.marketId]) {
            revert OrderNotActive();
        }
        if (o.nonce < orderNonceFloor[o.trader] || usedOrderNonce[o.trader][o.nonce]) revert NonceUsed();
        if (q.marketId != o.marketId || q.trader != o.trader) revert OrderMismatch();
        usedOrderNonce[o.trader][o.nonce] = true;

        uint256 mark = s.oracle.markOf(o.marketId).priceE18;
        if (mark == 0) revert NoMark();
        if (o.kind != 4 && o.triggerE18 != 0) {
            bool hit = o.triggerAbove ? mark >= o.triggerE18 : mark <= o.triggerE18;
            if (!hit) revert TriggerNotMet();
        }

        int256 size = s.positions[o.trader][o.marketId].size;
        int256 want = o.sizeBps > 0 ? M.fractionClose(size, o.sizeBps) : o.sizeDeltaE18;
        if (q.sizeDeltaE18 != want) revert OrderMismatch();
        if (o.reduceOnly && !M.isReducing(size, want)) revert NotReducing();
        if (M.diffBps(q.execPriceE18, mark) > uint256(o.maxSlippageBps)) revert Slippage();

        _execute(o.trader, q, quoteSig, o.marginUsdg, 1);
    }

    function cancelOrder(uint64 nonce) external {
        usedOrderNonce[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    /// Invalidates every order with a lower nonce.
    function cancelOrdersBefore(uint64 nonce) external {
        if (nonce > orderNonceFloor[msg.sender]) orderNonceFloor[msg.sender] = nonce;
    }

    /// Invalidates every unused quote with a lower nonce.
    function cancelQuotesBefore(uint64 nonce) external {
        if (nonce > quoteNonceFloor[msg.sender]) quoteNonceFloor[msg.sender] = nonce;
    }

    /// Binds the caller's trading fees to a referrer, once. The fee router pays the referrer its rebate first.
    function setReferrer(address referrer) external {
        if (referrer == address(0) || referrer == msg.sender) revert ZeroAddress();
        if (s.referrer[msg.sender] != address(0)) revert AlreadySet();
        s.referrer[msg.sender] = referrer;
        emit ReferrerSet(msg.sender, referrer);
    }

    // ------------------------------------------------------------------ risk

    /// Permissionless. See ExchangeLib.liquidate for the rules.
    function liquidate(address trader, bytes32 marketId) external {
        ExchangeLib.liquidate(s, trader, marketId, msg.sender);
    }

    /// Anyone (in practice the team) can pay a market's uncovered shortfall back into the Counter.
    function recapitalise(bytes32 marketId, uint256 amount) external {
        ExchangeLib.recapitalise(s, marketId, amount, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function capacity(bytes32 marketId) external view returns (uint256 longRoomUsdg, uint256 shortRoomUsdg) {
        return ExchangeLib.capacity(s, marketId);
    }

    function markEpoch() external view returns (uint256) {
        return ExchangeLib.markEpoch(s);
    }

    function traderUnrealizedPnlUsdg() external view returns (int256) {
        return ExchangeLib.traderUnrealizedPnl(s);
    }

    function counterReserveUsdg() external view returns (uint256) {
        return ExchangeLib.counterReserve(s);
    }

    function navPricesFresh() external view returns (bool) {
        return ExchangeLib.navPricesFresh(s);
    }

    function hasOpenInterest() external view returns (bool) {
        return ExchangeLib.hasOpenInterest(s);
    }

    function referrerOf(address trader) external view returns (address) {
        return s.referrer[trader];
    }

    function closedAtOf(address trader, bytes32 marketId) external view returns (uint64) {
        return s.closedAt[trader][marketId];
    }

    function positionOf(address trader, bytes32 marketId) external view returns (Position memory) {
        return s.positions[trader][marketId];
    }

    function configOf(bytes32 marketId) external view returns (MarketConfig memory) {
        return s.markets[marketId].cfg;
    }

    function marketInfo(bytes32 marketId)
        external
        view
        returns (uint128 longOI, uint128 shortOI, uint128 longSize, uint128 shortSize, uint128 badDebt)
    {
        Market storage d = s.markets[marketId];
        return (d.longOI, d.shortOI, d.longSize, d.shortSize, d.badDebt);
    }

    function marketCount() external view returns (uint256) {
        return s.marketIds.length;
    }

    function marketIdAt(uint256 i) external view returns (bytes32) {
        return s.marketIds[i];
    }

    function collateral(address trader) external view returns (uint256) {
        return s.collateral[trader];
    }

    function walletNotional(address trader) external view returns (uint256) {
        return s.walletNotional[trader];
    }

    function totalAbsNet() external view returns (uint256) {
        return s.totalAbsNet;
    }

    function totalBadDebt() external view returns (uint256) {
        return s.totalBadDebt;
    }

    function deps() external view returns (Deps memory) {
        return Deps(s.usdg, s.oracle, s.vault, s.backstop, s.firstLoss, s.feeRouter, s.payoutDesk);
    }

    // ------------------------------------------------------------------ admin: markets (tighten instantly, loosen after 24h)

    function scheduleMarket(bytes32 marketId, MarketConfig calldata c) external onlyOwner {
        (bool loosening, uint64 eta) = MarketConfigLib.schedule(s.markets[marketId], s.pending[marketId], c);
        emit MarketScheduled(marketId, eta, loosening);
    }

    /// Anyone can apply a due change. Reverts unless the oracle config exists and all session profiles are set: no silent defaults.
    function applyMarket(bytes32 marketId) external {
        if (s.oracle.configOf(marketId).maxAgeSec == 0) revert OracleNotConfigured();
        Market storage d = s.markets[marketId];
        if (!d.exists && s.marketIds.length >= MAX_MARKETS) revert TooManyMarkets();
        if (MarketConfigLib.applyPending(d, s.pending[marketId])) s.marketIds.push(marketId);
        emit MarketStateChanged(marketId, d.cfg.state);
    }

    function pendingOf(bytes32 marketId) external view returns (PendingMarket memory) {
        return s.pending[marketId];
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    /// Tighten-only: the guardian (or owner) can stop new entries or go close-only, never reopen. Cancels queued loosening.
    function guardianSetState(bytes32 marketId, MarketState state) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        if (state != MarketState.CloseOnly && state != MarketState.Paused) revert BadState();
        Market storage d = s.markets[marketId];
        if (!d.exists) revert UnknownMarket();
        d.cfg.state = state;
        delete s.pending[marketId];
        emit MarketStateChanged(marketId, state);
    }

    // ------------------------------------------------------------------ admin: quote signers (remove instantly, add after 24h)

    function setQuoteSigner(address signer, bool allowed) external onlyOwner {
        if (!allowed) {
            if (isQuoteSigner[signer]) {
                isQuoteSigner[signer] = false;
                --quoteSignerCount;
            }
            delete quoteSignerActivatesAt[signer];
            emit QuoteSignerChanged(signer, false, uint64(block.timestamp));
            return;
        }
        if (signer == address(0) || isQuoteSigner[signer]) revert AlreadySigner();
        uint64 eta = uint64(block.timestamp + CHANGE_DELAY);
        quoteSignerActivatesAt[signer] = eta;
        emit QuoteSignerChanged(signer, true, eta);
    }

    function applyQuoteSigner(address signer) external {
        uint64 eta = quoteSignerActivatesAt[signer];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TooEarly();
        if (quoteSignerCount == MAX_QUOTE_SIGNERS) revert SignerLimit();
        delete quoteSignerActivatesAt[signer];
        isQuoteSigner[signer] = true;
        ++quoteSignerCount;
        emit QuoteSignerChanged(signer, true, uint64(block.timestamp));
    }

    // ================================================================== internals

    function _deposit(address trader, uint256 amount) private {
        s.usdg.safeTransferFrom(trader, address(this), amount);
        s.collateral[trader] += amount;
        emit Deposited(trader, amount);
    }

    function _permit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 sig_s) private {
        try IERC20Permit(address(s.usdg)).permit(msg.sender, address(this), amount, deadline, v, r, sig_s) {} catch {}
    }

    function _execute(address trader, TradeQuote calldata q, bytes calldata sig, uint256 margin, uint8 path) private {
        if (q.trader != trader) revert WrongTrader();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (q.nonce < quoteNonceFloor[trader] || usedQuoteNonce[trader][q.nonce]) revert NonceUsed();
        if (!isQuoteSigner[ECDSA.recover(_hashQuote(q), sig)]) revert BadSigner();
        usedQuoteNonce[trader][q.nonce] = true;
        ExchangeLib.applyTrade(
            s,
            Trade(
                trader,
                q.marketId,
                q.sizeDeltaE18,
                q.execPriceE18,
                q.feeUsdg,
                margin,
                q.maxLeverageE18,
                q.markSequence,
                path,
                true,
                false
            )
        );
    }

    function _hashQuote(TradeQuote calldata q) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.marketId,
                    q.trader,
                    q.sizeDeltaE18,
                    q.execPriceE18,
                    q.feeUsdg,
                    q.maxLeverageE18,
                    q.markSequence,
                    q.nonce,
                    q.expiry
                )
            )
        );
    }

    function _hashOrder(Order calldata o) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    o.marketId,
                    o.trader,
                    o.kind,
                    o.sizeDeltaE18,
                    o.sizeBps,
                    o.triggerE18,
                    o.triggerAbove,
                    o.reduceOnly,
                    o.maxSlippageBps,
                    o.marginUsdg,
                    o.validAfter,
                    o.expiry,
                    o.nonce
                )
            )
        );
    }
}
