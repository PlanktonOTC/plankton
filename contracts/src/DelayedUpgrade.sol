// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice UUPS upgrades that must be announced and then wait 48 hours.
/// Anyone can watch `UpgradeScheduled` and exit before an upgrade lands. A scheduled upgrade that is not carried out
/// within 7 days of becoming due lapses and must be announced again, so an old announcement cannot be used by surprise.
/// State lives in an ERC-7201 namespace, so this base never shifts the storage of the contract that inherits it.
abstract contract DelayedUpgrade is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public constant UPGRADE_WINDOW = 7 days;

    /// @custom:storage-location erc7201:plankton.storage.DelayedUpgrade
    struct DelayedUpgradeStorage {
        address pendingImplementation;
        uint64 upgradeEta;
    }

    // keccak256(abi.encode(uint256(keccak256("plankton.storage.DelayedUpgrade")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x95ea05398e36206297e457f2372523a543416f9496fcf6d065ede8257cd42c00;

    event UpgradeScheduled(address indexed implementation, uint64 eta);
    event UpgradeCancelled(address indexed implementation);

    error UpgradeNotScheduled();
    error UpgradeTooEarly();
    error UpgradeLapsed();

    function __DelayedUpgrade_init(address owner_) internal onlyInitializing {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    function pendingImplementation() public view returns (address) {
        return _du().pendingImplementation;
    }

    function upgradeEta() public view returns (uint64) {
        return _du().upgradeEta;
    }

    function scheduleUpgrade(address implementation) external onlyOwner {
        if (implementation == address(0)) revert UpgradeNotScheduled();
        DelayedUpgradeStorage storage $ = _du();
        $.pendingImplementation = implementation;
        $.upgradeEta = uint64(block.timestamp + UPGRADE_DELAY);
        emit UpgradeScheduled(implementation, $.upgradeEta);
    }

    function cancelUpgrade() external onlyOwner {
        DelayedUpgradeStorage storage $ = _du();
        emit UpgradeCancelled($.pendingImplementation);
        delete $.pendingImplementation;
        delete $.upgradeEta;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        DelayedUpgradeStorage storage $ = _du();
        if (newImplementation == address(0) || newImplementation != $.pendingImplementation) {
            revert UpgradeNotScheduled();
        }
        if (block.timestamp < $.upgradeEta) revert UpgradeTooEarly();
        if (block.timestamp > uint256($.upgradeEta) + UPGRADE_WINDOW) revert UpgradeLapsed();
        delete $.pendingImplementation;
        delete $.upgradeEta;
    }

    function _du() private pure returns (DelayedUpgradeStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }
}
