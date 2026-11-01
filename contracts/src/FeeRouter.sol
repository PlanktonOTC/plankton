// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFeeRouter, IBackstopFund, ICounterVault} from "./interfaces/Interfaces.sol";

/// @notice Splits trading fees between the Counter, Backstop Fund, First-Loss tranche and treasury, on-chain.
/// A referral rebate (0-10%) comes off first. Split changes and rebate increases wait 24h; a rebate cut applies at once.
/// Pull-based: it only moves what a caller sends.
contract FeeRouter is IFeeRouter, Ownable2Step {
    using SafeERC20 for IERC20;

    struct Split {
        uint16 counterBps;
        uint16 backstopBps;
        uint16 juniorBps;
        uint16 treasuryBps;
    }

    uint256 public constant SPLIT_DELAY = 24 hours;
    uint256 public constant MAX_REFERRAL_BPS = 1_000;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdg;
    ICounterVault public immutable vault;
    IBackstopFund public immutable backstop;
    address public immutable firstLoss;
    address public treasury;

    Split public split;
    Split public pendingSplit;
    uint64 public pendingSplitEta;

    uint16 public referralBps = uint16(MAX_REFERRAL_BPS);
    uint16 public pendingReferralBps;
    uint64 public pendingReferralEta;

    event Routed(uint256 fee, uint256 referral, uint256 counter, uint256 backstop, uint256 junior, uint256 treasury);
    event SplitScheduled(Split split, uint64 eta);
    event TreasuryChanged(address treasury);
    event ReferralBpsScheduled(uint16 bps, uint64 eta);

    error BadSplit();
    error NothingPending();
    error TooEarly();
    error ZeroAddress();

    constructor(
        IERC20 usdg_,
        ICounterVault vault_,
        IBackstopFund backstop_,
        address firstLoss_,
        address treasury_,
        Split memory initialSplit,
        address owner_
    ) Ownable(owner_) {
        if (treasury_ == address(0) || firstLoss_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        vault = vault_;
        backstop = backstop_;
        firstLoss = firstLoss_;
        treasury = treasury_;
        _checkSplit(initialSplit);
        split = initialSplit;
    }

    function route(uint256 feeUsdg, address referrer) external {
        if (feeUsdg == 0) return;
        usdg.safeTransferFrom(msg.sender, address(this), feeUsdg);

        uint256 rebate = referrer != address(0) ? feeUsdg * referralBps / BPS : 0;
        if (rebate > 0) usdg.safeTransfer(referrer, rebate);
        uint256 net = feeUsdg - rebate;

        Split memory s = split;
        uint256 toBackstop = net * s.backstopBps / BPS;
        // Once the Backstop Fund is full its share goes to the Counter instead.
        if (toBackstop > 0 && usdg.balanceOf(address(backstop)) >= backstop.targetUsdg()) toBackstop = 0;
        uint256 toJunior = net * s.juniorBps / BPS;
        uint256 toTreasury = net * s.treasuryBps / BPS;
        uint256 toCounter = net - toBackstop - toJunior - toTreasury;

        if (toCounter > 0) usdg.safeTransfer(address(vault), toCounter);
        if (toBackstop > 0) usdg.safeTransfer(address(backstop), toBackstop);
        if (toJunior > 0) usdg.safeTransfer(firstLoss, toJunior);
        if (toTreasury > 0) usdg.safeTransfer(treasury, toTreasury);
        emit Routed(feeUsdg, rebate, toCounter, toBackstop, toJunior, toTreasury);
    }

    function scheduleSplit(Split calldata s) external onlyOwner {
        _checkSplit(s);
        pendingSplit = s;
        pendingSplitEta = uint64(block.timestamp + SPLIT_DELAY);
        emit SplitScheduled(s, pendingSplitEta);
    }

    function applySplit() external {
        if (pendingSplitEta == 0) revert NothingPending();
        if (block.timestamp < pendingSplitEta) revert TooEarly();
        split = pendingSplit;
        delete pendingSplit;
        delete pendingSplitEta;
    }

    /// A cut applies at once (more fee stays with the Counter); a raise waits 24h.
    function setReferralBps(uint16 bps) external onlyOwner {
        if (bps > MAX_REFERRAL_BPS) revert BadSplit();
        if (bps <= referralBps) {
            referralBps = bps;
            delete pendingReferralBps;
            delete pendingReferralEta;
            emit ReferralBpsScheduled(bps, uint64(block.timestamp));
            return;
        }
        pendingReferralBps = bps;
        pendingReferralEta = uint64(block.timestamp + SPLIT_DELAY);
        emit ReferralBpsScheduled(bps, pendingReferralEta);
    }

    function applyReferralBps() external {
        if (pendingReferralEta == 0) revert NothingPending();
        if (block.timestamp < pendingReferralEta) revert TooEarly();
        referralBps = pendingReferralBps;
        delete pendingReferralBps;
        delete pendingReferralEta;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function _checkSplit(Split memory s) private pure {
        if (uint256(s.counterBps) + s.backstopBps + s.juniorBps + s.treasuryBps != BPS) revert BadSplit();
    }
}
