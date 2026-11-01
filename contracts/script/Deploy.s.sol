// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {CounterVault} from "../src/CounterVault.sol";
import {Exchange} from "../src/Exchange.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {PayoutDesk} from "../src/PayoutDesk.sol";
import {BackstopFund, FirstLossTranche} from "../src/Reserves.sol";
import {
    IBackstopFund,
    ICounterVault,
    IFirstLossTranche,
    IFeeRouter,
    IMarkOracle,
    IPayoutDesk
} from "../src/interfaces/Interfaces.sol";

/// @notice Deploys and wires the whole system, then writes ../deployments/4663.json.
///
/// Run (the deployer key comes from the command line, never from this file):
///   OWNER=0x.. GUARDIAN=0x.. TREASURY=0x.. MARK_SIGNERS=0xA,0xB QUOTE_SIGNERS=0xC \
///   forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <deployer key>
///
/// The deployer owns everything while it wires the contracts, then offers ownership to OWNER (two-step: OWNER must
/// call acceptOwnership() on each contract). The Exchange needs ExchangeLib and MarketConfigLib linked; `forge script`
/// deploys and links them automatically.
contract Deploy is Script {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    struct Deployed {
        MarkOracle oracle;
        CounterVault vault;
        Exchange exchange;
        BackstopFund backstop;
        FirstLossTranche firstLoss;
        FeeRouter feeRouter;
        PayoutDesk payoutDesk;
    }

    function run() external returns (Deployed memory d) {
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address treasury = vm.envAddress("TREASURY");
        address[] memory markSigners = vm.envAddress("MARK_SIGNERS", ",");
        address[] memory quoteSigners = vm.envAddress("QUOTE_SIGNERS", ",");
        require(markSigners.length >= 1 && markSigners.length <= 3, "1 to 3 mark signers");
        require(quoteSigners.length >= 1 && quoteSigners.length <= 3, "1 to 3 quote signers");
        IERC20 usdg = IERC20(USDG);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        d.oracle = new MarkOracle(deployer, markSigners);

        CounterVault vaultImpl = new CounterVault();
        d.vault = CounterVault(
            address(new ERC1967Proxy(address(vaultImpl), abi.encodeCall(CounterVault.initialize, (usdg, deployer))))
        );

        d.backstop = new BackstopFund(usdg, deployer);
        d.firstLoss = new FirstLossTranche(usdg, deployer);
        d.payoutDesk = new PayoutDesk(deployer);
        // v1 split: Counter 75%, Backstop 20% (until full), First-Loss 0%, treasury 5%.
        d.feeRouter = new FeeRouter(
            usdg,
            ICounterVault(address(d.vault)),
            IBackstopFund(address(d.backstop)),
            address(d.firstLoss),
            treasury,
            FeeRouter.Split({counterBps: 7_500, backstopBps: 2_000, juniorBps: 0, treasuryBps: 500}),
            deployer
        );

        Exchange exchangeImpl = new Exchange();
        Exchange.Deps memory deps = Exchange.Deps({
            usdg: usdg,
            oracle: IMarkOracle(address(d.oracle)),
            vault: ICounterVault(address(d.vault)),
            backstop: IBackstopFund(address(d.backstop)),
            firstLoss: IFirstLossTranche(address(d.firstLoss)),
            feeRouter: IFeeRouter(address(d.feeRouter)),
            payoutDesk: IPayoutDesk(address(d.payoutDesk))
        });
        d.exchange = Exchange(
            address(
                new ERC1967Proxy(
                    address(exchangeImpl), abi.encodeCall(Exchange.initialize, (deployer, deps, quoteSigners))
                )
            )
        );

        // One-time wiring, now that every address exists.
        d.backstop.link(address(d.exchange), ICounterVault(address(d.vault)));
        d.firstLoss.link(address(d.exchange), ICounterVault(address(d.vault)));
        d.payoutDesk.link(address(d.exchange), ICounterVault(address(d.vault)));
        d.vault.link(d.exchange, IPayoutDesk(address(d.payoutDesk)));
        d.payoutDesk.setGuardian(guardian);
        d.exchange.setGuardian(guardian);

        if (owner != deployer) {
            d.oracle.transferOwnership(owner);
            d.vault.transferOwnership(owner);
            d.exchange.transferOwnership(owner);
            d.backstop.transferOwnership(owner);
            d.firstLoss.transferOwnership(owner);
            d.payoutDesk.transferOwnership(owner);
            d.feeRouter.transferOwnership(owner);
        }
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeAddress(k, "usdg", USDG);
        vm.serializeAddress(k, "oracle", address(d.oracle));
        vm.serializeAddress(k, "exchange", address(d.exchange));
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "backstop", address(d.backstop));
        vm.serializeAddress(k, "firstLoss", address(d.firstLoss));
        vm.serializeAddress(k, "feeRouter", address(d.feeRouter));
        vm.serializeAddress(k, "payoutDesk", address(d.payoutDesk));
        // The time, not block.number: on Arbitrum-style chains block.number is the Ethereum block number, which is
        // useless for querying this chain's logs. The indexer finds the matching block from the time.
        string memory out = vm.serializeUint(k, "deployedAt", block.timestamp);
        vm.writeJson(out, "../deployments/4663.json");

        console2.log("exchange   ", address(d.exchange));
        console2.log("oracle     ", address(d.oracle));
        console2.log("vault      ", address(d.vault));
        console2.log("owner offered to", owner, "(they must call acceptOwnership on each contract)");
    }
}
