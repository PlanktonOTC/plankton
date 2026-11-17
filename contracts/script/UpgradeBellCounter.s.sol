// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {CounterVault} from "../src/CounterVault.sol";

/// @notice Owner-only second phase for Bell after DeployBell has published its addresses.
/// Run once with ACTION=schedule, wait at least 48 hours, then ACTION=execute.
contract UpgradeBellCounter is Script {
    function run() external {
        require(block.chainid == 4663, "Robinhood Chain only");
        CounterVault counter = CounterVault(vm.envAddress("COUNTER"));
        address implementation = vm.envAddress("COUNTER_IMPLEMENTATION");
        address book = vm.envAddress("BELL_OPTIONS_BOOK");
        string memory action = vm.envString("ACTION");

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        if (keccak256(bytes(action)) == keccak256("schedule")) {
            require(counter.owner() == sender, "sign with the current Counter owner");
            require(counter.optionsBook() == address(0), "Bell book already linked");
            counter.scheduleUpgrade(implementation);
            console2.log("upgrade ETA", counter.upgradeEta());
        } else if (keccak256(bytes(action)) == keccak256("execute")) {
            require(counter.owner() == sender, "sign with the current Counter owner");
            require(counter.pendingImplementation() == implementation, "scheduled implementation mismatch");
            require(block.timestamp >= counter.upgradeEta(), "48-hour delay has not elapsed");
            counter.upgradeToAndCall(implementation, bytes(""));
            counter.linkOptionsBook(book);
            require(counter.optionsBook() == book, "book link failed");
            console2.log("Counter upgraded and options book linked", book);
        } else {
            revert("ACTION must be schedule or execute");
        }
        vm.stopBroadcast();
    }
}
