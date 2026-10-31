// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPayoutDesk, ICounterVault} from "./interfaces/Interfaces.sol";

/// @notice Large trader profits are paid late, not refused. The Exchange records an IOU here; after a short delay the
/// trader claims it and the Counter vault pays it out. Margin is never routed through this desk.
/// The guardian can freeze a claim, but only until 72h after it became claimable.
contract PayoutDesk is IPayoutDesk, Ownable2Step {
    struct Claim {
        address trader;
        uint128 amount;
        uint64 claimableAt;
        uint64 frozenUntil;
        bool claimed;
    }

    uint64 public constant DELAY = 1 hours;
    uint64 public constant MAX_FREEZE = 72 hours;

    address public exchange;
    ICounterVault public vault;
    address public guardian;

    mapping(uint256 => Claim) public claims;
    uint256 public nextClaimId = 1;
    /// Sum of unclaimed IOUs. The vault subtracts this from its NAV so LPs cannot withdraw it.
    uint256 public outstanding;

    event Deferred(uint256 indexed id, address indexed trader, uint256 amount, uint64 claimableAt);
    event Claimed(uint256 indexed id, address indexed trader, uint256 amount);
    event Frozen(uint256 indexed id, uint64 until);
    event GuardianChanged(address guardian);

    error AlreadyLinked();
    error NotExchange();
    error NotGuardian();
    error NotClaimable();
    error ZeroAddress();
    error BadFreeze();

    constructor(address owner_) Ownable(owner_) {}

    function link(address exchange_, ICounterVault vault_) external onlyOwner {
        if (exchange != address(0)) revert AlreadyLinked();
        if (exchange_ == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        exchange = exchange_;
        vault = vault_;
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    function defer(address trader, uint256 amountUsdg) external returns (uint64 claimableAt) {
        if (msg.sender != exchange) revert NotExchange();
        claimableAt = uint64(block.timestamp) + DELAY;
        uint256 id = nextClaimId++;
        claims[id] = Claim(trader, uint128(amountUsdg), claimableAt, 0, false);
        outstanding += amountUsdg;
        emit Deferred(id, trader, amountUsdg, claimableAt);
    }

    /// Anyone may trigger a claim; the money always goes to the trader. Reverts (and stays claimable) if the vault is short of cash.
    function claim(uint256 id) external {
        Claim storage c = claims[id];
        if (c.claimed || c.trader == address(0)) revert NotClaimable();
        if (block.timestamp < c.claimableAt || block.timestamp < c.frozenUntil) revert NotClaimable();
        c.claimed = true;
        outstanding -= c.amount;
        vault.payOut(c.trader, c.amount);
        emit Claimed(id, c.trader, c.amount);
    }

    function freeze(uint256 id, uint64 until) external {
        if (msg.sender != guardian) revert NotGuardian();
        Claim storage c = claims[id];
        if (c.claimed || c.trader == address(0)) revert NotClaimable();
        if (until > c.claimableAt + MAX_FREEZE) revert BadFreeze();
        c.frozenUntil = until;
        emit Frozen(id, until);
    }
}
