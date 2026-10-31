// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IBackstopFund, IFirstLossTranche, ICounterVault} from "./interfaces/Interfaces.sol";

/// @notice Shared base: a pot of USDG the Exchange can draw on, and only ever send to the Counter vault.
/// The owner has no function that moves these funds. Anyone can top the pot up by transferring USDG in.
abstract contract LossReserve is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    address public exchange;
    ICounterVault public vault;

    error AlreadyLinked();
    error NotExchange();
    error ZeroAddress();

    constructor(IERC20 usdg_, address owner_) Ownable(owner_) {
        usdg = usdg_;
    }

    /// One-time wiring, because the Exchange and the reserves are deployed before they can point at each other.
    function link(address exchange_, ICounterVault vault_) external onlyOwner {
        if (exchange != address(0)) revert AlreadyLinked();
        if (exchange_ == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        exchange = exchange_;
        vault = vault_;
    }

    modifier onlyExchange() {
        if (msg.sender != exchange) revert NotExchange();
        _;
    }

    function _sendToVault(uint256 amount) internal returns (uint256 sent) {
        uint256 bal = usdg.balanceOf(address(this));
        sent = amount < bal ? amount : bal;
        if (sent > 0) usdg.safeTransfer(address(vault), sent);
    }
}

/// @notice Team-funded buffer. Target is 10% of Counter NAV; its fee share overflows to the Counter once full.
contract BackstopFund is IBackstopFund, LossReserve {
    uint256 public constant TARGET_BPS = 1_000;

    event Covered(bytes32 indexed marketId, uint256 requested, uint256 covered);

    constructor(IERC20 usdg_, address owner_) LossReserve(usdg_, owner_) {}

    function cover(bytes32 marketId, uint256 amountUsdg) external onlyExchange returns (uint256 covered) {
        covered = _sendToVault(amountUsdg);
        emit Covered(marketId, amountUsdg, covered);
    }

    function targetUsdg() external view returns (uint256) {
        return vault.navUsdg() * TARGET_BPS / 10_000;
    }
}

/// @notice Team bond that absorbs losses after the Backstop Fund and before Counter LPs (v1).
contract FirstLossTranche is IFirstLossTranche, LossReserve {
    event Absorbed(uint256 requested, uint256 absorbed);

    constructor(IERC20 usdg_, address owner_) LossReserve(usdg_, owner_) {}

    function absorb(uint256 amountUsdg) external onlyExchange returns (uint256 absorbed) {
        absorbed = _sendToVault(amountUsdg);
        emit Absorbed(amountUsdg, absorbed);
    }
}
