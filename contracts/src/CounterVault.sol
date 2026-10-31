// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {DelayedUpgrade} from "./DelayedUpgrade.sol";
import {ICounterVault, IExchangeCounterView, IPayoutDesk} from "./interfaces/Interfaces.sol";

/// @notice The Counter: the single LP pool that takes the other side of every trade. Shares are an ERC-20.
/// - Two-step: a request settles only after the next mark, at the worse of the request-time and settle-time price.
/// - Withdrawals fill pro-rata from free cash each round and are never cancelled. After 72h unfilled the vault
///   reports `deleveraging()`, which stops opens on the Exchange until the queue clears.
/// - Exits are never paused. Only new deposits can be paused.
contract CounterVault is ICounterVault, ERC20Upgradeable, DelayedUpgrade {
    using SafeERC20 for IERC20;

    /// 10**3 virtual shares and 1 virtual asset: blocks the first-depositor inflation attack.
    uint8 private constant OFFSET = 3;
    uint256 public constant HARD_MAX_WAIT = 72 hours;
    uint256 private constant E18 = 1e18;

    struct Request {
        address owner;
        bool isDeposit;
        bool done;
        uint64 requestedAt;
        uint128 amount; // assets for a deposit, shares for a withdrawal
        uint128 filled; // shares filled so far (withdrawals)
        uint256 epoch; // Exchange.markEpoch() when requested
        uint256 npsE18; // assets per share-unit when requested, E18
    }

    IERC20 public usdg;
    IExchangeCounterView public exchange;
    IPayoutDesk public payoutDesk;
    uint256 public escrowedDeposits;
    bool public depositsPaused;

    mapping(uint256 => Request) public requests;
    uint256 public nextRequestId;
    uint256[] private _depositQueue;
    uint256[] private _withdrawQueue;
    uint256 private _depositHead;
    uint256 private _withdrawHead;

    event DepositRequested(uint256 indexed id, address indexed owner, uint256 assets);
    event WithdrawRequested(uint256 indexed id, address indexed owner, uint256 shares);
    event Settled(uint256 indexed id, address indexed owner, bool deposit, uint256 assets, uint256 shares);
    event PartialFill(uint256 indexed id, uint256 filledShares, uint256 remainingShares);
    event DepositsPaused(bool paused);

    error AlreadyLinked();
    error NotLinked();
    error NotAuthorized();
    error DepositsAreFrozen();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientCash();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(IERC20 usdg_, address owner_) external initializer {
        if (address(usdg_) == address(0)) revert ZeroAddress();
        __ERC20_init("Plankton Counter", "pkCTR");
        __DelayedUpgrade_init(owner_);
        usdg = usdg_;
        nextRequestId = 1;
    }

    /// One-time wiring to the Exchange and PayoutDesk.
    function link(IExchangeCounterView exchange_, IPayoutDesk desk_) external onlyOwner {
        if (address(exchange) != address(0)) revert AlreadyLinked();
        if (address(exchange_) == address(0) || address(desk_) == address(0)) revert ZeroAddress();
        exchange = exchange_;
        payoutDesk = desk_;
    }

    function decimals() public pure override returns (uint8) {
        return 6 + OFFSET;
    }

    // ---------------------------------------------------------------- accounting

    function cashUsdg() public view returns (uint256) {
        return usdg.balanceOf(address(this)) - escrowedDeposits;
    }

    /// Cash, minus claims owed to traders, minus trader unrealized profit (plus their unrealized losses).
    function navUsdg() public view returns (uint256) {
        int256 nav = int256(cashUsdg());
        if (address(payoutDesk) != address(0)) nav -= int256(payoutDesk.outstanding());
        if (address(exchange) != address(0)) nav -= exchange.traderUnrealizedPnlUsdg();
        return nav > 0 ? uint256(nav) : 0;
    }

    function navE18() external view returns (uint256) {
        return navUsdg() * 1e12;
    }

    /// Cash that is not tied up backing open positions or owed to traders.
    function freeCash() public view returns (uint256) {
        uint256 cash = cashUsdg();
        uint256 reserved = address(exchange) == address(0) ? 0 : exchange.counterReserveUsdg();
        if (address(payoutDesk) != address(0)) reserved += payoutDesk.outstanding();
        return cash > reserved ? cash - reserved : 0;
    }

    /// Assets per share-unit, E18, with virtual shares and assets.
    function navPerShareE18() public view returns (uint256) {
        return (navUsdg() + 1) * E18 / (totalSupply() + 10 ** OFFSET);
    }

    function oldestPendingWithdrawAge() public view returns (uint64) {
        for (uint256 i = _withdrawHead; i < _withdrawQueue.length; ++i) {
            Request storage r = requests[_withdrawQueue[i]];
            if (!r.done) return uint64(block.timestamp) - r.requestedAt;
        }
        return 0;
    }

    function deleveraging() external view returns (bool) {
        return oldestPendingWithdrawAge() > HARD_MAX_WAIT;
    }

    // ---------------------------------------------------------------- requests

    function requestDeposit(uint256 assets) external returns (uint256 id) {
        return _requestDeposit(assets);
    }

    /// The permit is attempted but its failure is ignored: a front-run permit must not block the deposit.
    function requestDepositWithPermit(uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 id)
    {
        try IERC20Permit(address(usdg)).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return _requestDeposit(assets);
    }

    /// Withdrawals are never paused.
    function requestWithdraw(uint256 shares) external returns (uint256 id) {
        if (shares == 0) revert ZeroAmount();
        _requireLinked();
        _transfer(msg.sender, address(this), shares);
        id = _newRequest(msg.sender, false, shares);
        _withdrawQueue.push(id);
        emit WithdrawRequested(id, msg.sender, shares);
    }

    function _requestDeposit(uint256 assets) private returns (uint256 id) {
        if (depositsPaused) revert DepositsAreFrozen();
        if (assets == 0) revert ZeroAmount();
        _requireLinked();
        usdg.safeTransferFrom(msg.sender, address(this), assets);
        escrowedDeposits += assets;
        id = _newRequest(msg.sender, true, assets);
        _depositQueue.push(id);
        emit DepositRequested(id, msg.sender, assets);
    }

    function _newRequest(address owner_, bool isDeposit, uint256 amount) private returns (uint256 id) {
        id = nextRequestId++;
        requests[id] = Request({
            owner: owner_,
            isDeposit: isDeposit,
            done: false,
            requestedAt: uint64(block.timestamp),
            amount: uint128(amount),
            filled: 0,
            epoch: exchange.markEpoch(),
            npsE18: navPerShareE18()
        });
    }

    // ---------------------------------------------------------------- settlement

    /// Permissionless. Processes up to `maxRequests` that have seen a new mark since they were requested.
    function settle(uint256 maxRequests) external {
        _requireLinked();
        uint256 epoch = exchange.markEpoch();
        uint256 budget = maxRequests;

        while (budget > 0 && _depositHead < _depositQueue.length) {
            uint256 id = _depositQueue[_depositHead];
            Request storage r = requests[id];
            if (epoch <= r.epoch) break;
            _settleDeposit(id, r);
            ++_depositHead;
            --budget;
        }
        _settleWithdrawals(epoch, budget);
    }

    function _settleDeposit(uint256 id, Request storage r) private {
        uint256 nps = navPerShareE18();
        uint256 price = r.npsE18 > nps ? r.npsE18 : nps; // worse of the two prices for the depositor
        uint256 shares = uint256(r.amount) * E18 / price;
        escrowedDeposits -= r.amount;
        r.done = true;
        r.filled = r.amount;
        _mint(r.owner, shares);
        emit Settled(id, r.owner, true, r.amount, shares);
    }

    function _settleWithdrawals(uint256 epoch, uint256 budget) private {
        while (_withdrawHead < _withdrawQueue.length && requests[_withdrawQueue[_withdrawHead]].done) ++_withdrawHead;
        if (budget == 0) return;

        uint256[] memory ids = new uint256[](budget);
        uint256[] memory want = new uint256[](budget);
        uint256 n;
        uint256 total;
        uint256 nps = navPerShareE18();
        for (uint256 i = _withdrawHead; i < _withdrawQueue.length && n < budget; ++i) {
            Request storage r = requests[_withdrawQueue[i]];
            if (r.done) continue;
            if (epoch <= r.epoch) break;
            uint256 price = r.npsE18 < nps ? r.npsE18 : nps; // worse of the two prices for the withdrawer
            ids[n] = _withdrawQueue[i];
            want[n] = (uint256(r.amount) - r.filled) * price / E18;
            total += want[n];
            ++n;
        }
        if (n == 0) return;

        uint256 free = freeCash();
        for (uint256 j; j < n; ++j) {
            Request storage r = requests[ids[j]];
            uint256 remaining = uint256(r.amount) - r.filled;
            uint256 shares;
            uint256 assets;
            if (total <= free) {
                shares = remaining;
                assets = want[j];
            } else {
                // Not enough free cash: everyone in this round is filled in the same proportion.
                shares = remaining * free / total;
                assets = want[j] * free / total;
            }
            if (shares == 0) continue;
            r.filled += uint128(shares);
            if (r.filled == r.amount) r.done = true;
            _burn(address(this), shares);
            usdg.safeTransfer(r.owner, assets);
            if (r.done) emit Settled(ids[j], r.owner, false, assets, shares);
            else emit PartialFill(ids[j], r.filled, uint256(r.amount) - r.filled);
        }
    }

    // ---------------------------------------------------------------- Exchange / PayoutDesk access

    /// Pays winning traders. Only the Exchange and the PayoutDesk can call it, and only from cash on hand.
    function payOut(address to, uint256 amount) external {
        if (msg.sender != address(exchange) && msg.sender != address(payoutDesk)) revert NotAuthorized();
        if (amount > cashUsdg()) revert InsufficientCash();
        usdg.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- admin (new entries only)

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function _requireLinked() private view {
        if (address(exchange) == address(0)) revert NotLinked();
    }
}
