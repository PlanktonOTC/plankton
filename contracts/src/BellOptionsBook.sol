// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICounterVault, IMarkOracle, IExchangeMarketRisk} from "./interfaces/Interfaces.sol";
import {BellSettlementOracle} from "./BellSettlementOracle.sol";

/// @notice Capped, cash-settled Bell contracts. New orders are disabled until operators configure signed data sources.
/// The buyer pays the premium to the Counter. The Counter reserves the maximum payout plus the tie refund.
contract BellOptionsBook is EIP712, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_MARK_AGE = 60 seconds;
    uint256 public constant MIN_EXPIRY = 1 days;
    uint256 public constant MAX_EXPIRY = 180 days;
    uint256 public constant MIN_PREMIUM_BPS = 1_000;
    uint256 public constant TICKER_CAP_BPS = 1_000;
    uint256 public constant TICKER_COMBINED_CAP_BPS = 1_500;
    uint256 public constant WALLET_CAP_BPS = 200;
    uint256 public constant EXPIRY_CAP_BPS = 2_500;
    uint256 public constant GLOBAL_CAP_BPS = 5_000;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "BellQuote(address trader,bytes32 marketId,uint64 expiry,uint256 strikeE18,uint8 optionType,uint256 payoutUsdg,uint256 premiumUsdg,uint64 markSequence,uint64 validUntil,uint256 nonce)"
    );

    enum OptionType { Call, Put }
    enum Outcome { Unresolved, Win, Loss, Tie }

    struct Quote {
        address trader;
        bytes32 marketId;
        uint64 expiry;
        uint256 strikeE18;
        OptionType optionType;
        uint256 payoutUsdg;
        uint256 premiumUsdg;
        uint64 markSequence;
        uint64 validUntil;
        uint256 nonce;
    }

    struct Ticket {
        address buyer;
        bytes32 marketId;
        uint64 expiry;
        uint256 strikeE18;
        uint256 payoutUsdg;
        uint256 premiumUsdg;
        uint256 reservedUsdg;
        OptionType optionType;
        Outcome outcome;
        bool claimed;
    }

    IERC20 public immutable usdg;
    ICounterVault public immutable counter;
    IMarkOracle public immutable markOracle;
    IExchangeMarketRisk public immutable exchange;
    BellSettlementOracle public immutable settlementOracle;
    address public quoteSigner;
    bool public opensEnabled;
    uint256 public nextTicketId = 1;
    mapping(uint256 => Ticket) public tickets;
    mapping(uint256 => bool) public usedQuoteNonce;
    mapping(bytes32 => uint256) public marketExposureUsdg;
    mapping(bytes32 => uint256) public seriesExposureUsdg;
    mapping(uint64 => uint256) public expiryExposureUsdg;
    uint256 public totalExposureUsdg;
    mapping(address => mapping(bytes32 => uint256)) public walletMarketExposureUsdg;

    event OpensEnabled(bool enabled);
    event QuoteSignerChanged(address indexed signer);
    event TicketBought(uint256 indexed ticketId, address indexed buyer, bytes32 indexed marketId, uint64 expiry, uint256 strikeE18, uint256 payoutUsdg, uint256 premiumUsdg, OptionType optionType);
    event TicketResolved(uint256 indexed ticketId, Outcome outcome, uint256 liabilityUsdg, uint256 settlementPriceE18);
    event TicketClaimed(uint256 indexed ticketId, address indexed buyer, uint256 amountUsdg);

    error ZeroAddress();
    error OpensClosed();
    error BadQuote();
    error BadSignature();
    error QuoteUsed();
    error StaleMark();
    error RiskLimit();
    error NotReady();
    error AlreadyResolved();
    error NotClaimable();

    constructor(
        address owner_, IERC20 usdg_, ICounterVault counter_, IMarkOracle markOracle_,
        IExchangeMarketRisk exchange_, BellSettlementOracle settlementOracle_, address quoteSigner_
    ) EIP712("Plankton Bell Options", "1") Ownable(owner_) {
        if (owner_ == address(0) || address(usdg_) == address(0) || address(counter_) == address(0)
            || address(markOracle_) == address(0) || address(exchange_) == address(0)
            || address(settlementOracle_) == address(0) || quoteSigner_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        counter = counter_;
        markOracle = markOracle_;
        exchange = exchange_;
        settlementOracle = settlementOracle_;
        quoteSigner = quoteSigner_;
    }

    function setOpensEnabled(bool enabled) external onlyOwner {
        opensEnabled = enabled;
        emit OpensEnabled(enabled);
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        quoteSigner = signer;
        emit QuoteSignerChanged(signer);
    }

    function buy(Quote calldata q, bytes calldata signature) external returns (uint256 ticketId) {
        if (!opensEnabled) revert OpensClosed();
        IMarkOracle.Mark memory mark = markOracle.markOf(q.marketId);
        if (mark.status != IMarkOracle.Status.Open || mark.breaker || mark.updatedAt > block.timestamp
            || block.timestamp - mark.updatedAt > MAX_MARK_AGE || mark.sequence != q.markSequence) revert StaleMark();
        if (q.trader != msg.sender || q.marketId == bytes32(0) || q.expiry < block.timestamp + MIN_EXPIRY
            || q.expiry > block.timestamp + MAX_EXPIRY || q.validUntil < block.timestamp
            || q.validUntil > block.timestamp + MAX_MARK_AGE || q.strikeE18 == 0 || q.payoutUsdg == 0
            || q.premiumUsdg == 0 || q.optionType > OptionType.Put || usedQuoteNonce[q.nonce]) revert BadQuote();
        if (ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(
            QUOTE_TYPEHASH, q.trader, q.marketId, q.expiry, q.strikeE18, q.optionType,
            q.payoutUsdg, q.premiumUsdg, q.markSequence, q.validUntil, q.nonce
        ))), signature) != quoteSigner) revert BadSignature();

        (uint256 refClose,, bool hasReference) = settlementOracle.referenceOf(q.marketId, q.expiry);
        if (!hasReference || !_allowedStrike(q.strikeE18, refClose)) revert BadQuote();
        uint256 minPremium = Math.mulDiv(q.payoutUsdg, MIN_PREMIUM_BPS, BPS, Math.Rounding.Ceil);
        if (q.premiumUsdg < minPremium || q.premiumUsdg > q.payoutUsdg) revert BadQuote();

        uint256 nav = counter.navUsdg();
        if (nav == 0) revert RiskLimit();
        bytes32 series = settlementOracle.seriesKey(q.marketId, q.expiry);
        (uint128 longOI, uint128 shortOI,,,) = exchange.marketInfo(q.marketId);
        uint256 marketExposure = marketExposureUsdg[q.marketId];
        uint256 perpsGross = uint256(longOI) + shortOI;
        uint256 tickerCap = Math.mulDiv(nav, TICKER_CAP_BPS, BPS);
        uint256 combinedCap = Math.mulDiv(nav, TICKER_COMBINED_CAP_BPS, BPS);
        uint256 walletCap = Math.mulDiv(nav, WALLET_CAP_BPS, BPS);
        uint256 expiryCap = Math.mulDiv(nav, EXPIRY_CAP_BPS, BPS);
        uint256 globalCap = Math.mulDiv(nav, GLOBAL_CAP_BPS, BPS);
        if (_exceeds(marketExposure, q.payoutUsdg, tickerCap)
            || perpsGross > combinedCap
            || marketExposure > combinedCap - perpsGross
            || q.payoutUsdg > combinedCap - perpsGross - marketExposure
            || _exceeds(walletMarketExposureUsdg[msg.sender][q.marketId], q.payoutUsdg, walletCap)
            || _exceeds(expiryExposureUsdg[q.expiry], q.payoutUsdg, expiryCap)
            || _exceeds(totalExposureUsdg, q.payoutUsdg, globalCap)
            || q.premiumUsdg > type(uint256).max - q.payoutUsdg) revert RiskLimit();

        usedQuoteNonce[q.nonce] = true;
        marketExposureUsdg[q.marketId] += q.payoutUsdg;
        seriesExposureUsdg[series] += q.payoutUsdg;
        expiryExposureUsdg[q.expiry] += q.payoutUsdg;
        totalExposureUsdg += q.payoutUsdg;
        walletMarketExposureUsdg[msg.sender][q.marketId] += q.payoutUsdg;
        usdg.safeTransferFrom(msg.sender, address(counter), q.premiumUsdg);
        uint256 reserve = q.payoutUsdg + q.premiumUsdg;
        counter.reserveOptionPayout(reserve);
        ticketId = nextTicketId++;
        tickets[ticketId] = Ticket(msg.sender, q.marketId, q.expiry, q.strikeE18, q.payoutUsdg,
            q.premiumUsdg, reserve, q.optionType, Outcome.Unresolved, false);
        emit TicketBought(ticketId, msg.sender, q.marketId, q.expiry, q.strikeE18, q.payoutUsdg, q.premiumUsdg, q.optionType);
    }

    /// Anyone can resolve a ticket once its signed expiry result has been published.
    function resolve(uint256 ticketId) external {
        Ticket storage t = tickets[ticketId];
        if (t.buyer == address(0)) revert BadQuote();
        if (t.outcome != Outcome.Unresolved) revert AlreadyResolved();
        (uint256 settlement, bool resolved) = settlementOracle.settlementOf(t.marketId, t.expiry);
        if (!resolved) revert NotReady();
        Outcome outcome;
        uint256 liability;
        if (settlement == t.strikeE18) {
            outcome = Outcome.Tie;
            liability = t.premiumUsdg;
        } else if ((t.optionType == OptionType.Call && settlement > t.strikeE18)
            || (t.optionType == OptionType.Put && settlement < t.strikeE18)) {
            outcome = Outcome.Win;
            liability = t.payoutUsdg;
        } else {
            outcome = Outcome.Loss;
        }
        t.outcome = outcome;
        counter.settleOptionPayout(t.reservedUsdg, liability);
        bytes32 series = settlementOracle.seriesKey(t.marketId, t.expiry);
        marketExposureUsdg[t.marketId] -= t.payoutUsdg;
        seriesExposureUsdg[series] -= t.payoutUsdg;
        expiryExposureUsdg[t.expiry] -= t.payoutUsdg;
        totalExposureUsdg -= t.payoutUsdg;
        emit TicketResolved(ticketId, outcome, liability, settlement);
    }

    function claim(uint256 ticketId) external {
        Ticket storage t = tickets[ticketId];
        if (t.buyer != msg.sender || t.outcome == Outcome.Unresolved || t.claimed) revert NotClaimable();
        t.claimed = true;
        uint256 amount = t.outcome == Outcome.Win ? t.payoutUsdg : t.outcome == Outcome.Tie ? t.premiumUsdg : 0;
        if (amount != 0) counter.payOptionPayout(msg.sender, amount);
        emit TicketClaimed(ticketId, msg.sender, amount);
    }

    function _allowedStrike(uint256 strike, uint256 referencePrice) private pure returns (bool) {
        if (referencePrice == 0) return false;
        uint256 delta = strike > referencePrice ? strike - referencePrice : referencePrice - strike;
        if (delta > referencePrice / 2 || referencePrice > type(uint256).max / 50_000) return false;
        uint256 scaled = delta * BPS;
        uint256 base = referencePrice;
        return scaled >= base * 1_000 - base * 10 && scaled <= base * 1_000 + base * 10
            || scaled >= base * 2_500 - base * 10 && scaled <= base * 2_500 + base * 10
            || scaled >= base * 5_000 - base * 10 && scaled <= base * 5_000 + base * 10;
    }

    function _exceeds(uint256 current, uint256 added, uint256 cap) private pure returns (bool) {
        return current > cap || added > cap - current;
    }
}
