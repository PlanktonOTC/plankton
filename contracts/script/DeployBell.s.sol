// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CounterVault} from "../src/CounterVault.sol";
import {BellOptionsBook} from "../src/BellOptionsBook.sol";
import {BellSettlementOracle} from "../src/BellSettlementOracle.sol";
import {IMarkOracle, ICounterVault, IExchangeMarketRisk} from "../src/interfaces/Interfaces.sol";

/// @notice Deploys Bell contracts and a Counter implementation against an existing 4663 deployment.
/// Counter's owner must schedule and execute the implementation upgrade, then link the book after the delay.
/// Opens stay disabled until source operators and quote operations have been verified.
contract DeployBell is Script {
    function run() external {
        require(block.chainid == 4663, "Robinhood Chain only");
        address owner = vm.envAddress("OWNER");
        IERC20 usdg = IERC20(vm.envAddress("USDG"));
        CounterVault counter = CounterVault(vm.envAddress("COUNTER"));
        IMarkOracle markOracle = IMarkOracle(vm.envAddress("MARK_ORACLE"));
        IExchangeMarketRisk exchange = IExchangeMarketRisk(vm.envAddress("EXCHANGE"));
        address quoteSigner = vm.envAddress("QUOTE_SIGNER");
        address[] memory signers = vm.envAddress("SETTLEMENT_SIGNERS", ",");
        require(owner != address(0) && quoteSigner != address(0), "zero owner or quote signer");
        require(address(usdg).code.length != 0 && address(counter).code.length != 0, "missing existing deployment");
        require(signers.length == 3, "three settlement signers required");

        vm.startBroadcast();
        CounterVault implementation = new CounterVault();
        BellSettlementOracle settlement = new BellSettlementOracle(owner, [signers[0], signers[1], signers[2]]);
        BellOptionsBook book = new BellOptionsBook(
            owner, usdg, ICounterVault(address(counter)), markOracle, exchange, settlement, quoteSigner
        );
        vm.stopBroadcast();

        console2.log("counterImplementation", address(implementation));
        console2.log("bellSettlementOracle", address(settlement));
        console2.log("bellOptionsBook     ", address(book));
        console2.log("counter             ", address(counter));
        console2.log("owner               ", owner);
        console2.log("opensEnabled        ", book.opensEnabled());
        console2.log("Counter owner must schedule this implementation, wait 48h, upgrade, then link the book.");
    }
}
