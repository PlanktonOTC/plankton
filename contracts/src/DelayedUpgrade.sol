// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice UUPS upgrades that must be announced and then wait 48 hours.
/// Anyone can watch `UpgradeScheduled` and exit before an upgrade lands.
abstract contract DelayedUpgrade is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    uint256 public constant UPGRADE_DELAY = 48 hours;

    address public pendingImplementation;
    uint64 public upgradeEta;

    event UpgradeScheduled(address indexed implementation, uint64 eta);
    event UpgradeCancelled(address indexed implementation);

    error UpgradeNotScheduled();
    error UpgradeTooEarly();

    function __DelayedUpgrade_init(address owner_) internal onlyInitializing {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    function scheduleUpgrade(address implementation) external onlyOwner {
        if (implementation == address(0)) revert UpgradeNotScheduled();
        pendingImplementation = implementation;
        upgradeEta = uint64(block.timestamp + UPGRADE_DELAY);
        emit UpgradeScheduled(implementation, upgradeEta);
    }

    function cancelUpgrade() external onlyOwner {
        emit UpgradeCancelled(pendingImplementation);
        delete pendingImplementation;
        delete upgradeEta;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0) || newImplementation != pendingImplementation) revert UpgradeNotScheduled();
        if (block.timestamp < upgradeEta) revert UpgradeTooEarly();
        delete pendingImplementation;
        delete upgradeEta;
    }
}
