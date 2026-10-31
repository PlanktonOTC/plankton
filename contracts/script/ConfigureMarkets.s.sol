// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {Exchange} from "../src/Exchange.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";
import {MarketConfig, MarketState, SessionProfile} from "../src/ExchangeTypes.sol";

/// @notice Registers every enabled market from ../config/markets.json on the oracle and the Exchange.
///
/// Two steps, because a new market waits 24 hours before it can be applied:
///   forge script script/ConfigureMarkets.s.sol --sig "schedule()"   --rpc-url <rpc> --broadcast --private-key <owner key>
///   (24 hours later)
///   forge script script/ConfigureMarkets.s.sol --sig "applyAll()"   --rpc-url <rpc> --broadcast --private-key <anyone>
///
/// The sender of schedule() must be the contracts' owner. Optional env: INITIAL_V_USDG (default 50000e6, the R0 Counter size)
/// is used only to size the skew scale so a trade to the net-skew cap pays about 0.75%.
contract ConfigureMarkets is Script {
    struct Entry {
        string symbol;
        bool micro;
        address stockToken;
        address feed;
        uint32 chainlinkMaxAgeSec;
        uint128 absOiCapUsdg;
        bytes32 id;
    }

    function schedule() external {
        (MarkOracle oracle, Exchange exchange) = _contracts();
        uint256 v = vm.envOr("INITIAL_V_USDG", uint256(50_000e6));
        Entry[] memory entries = _entries();

        vm.startBroadcast();
        for (uint256 i; i < entries.length; ++i) {
            Entry memory e = entries[i];
            oracle.scheduleConfig(e.id, _oracleConfig(e));
            exchange.scheduleMarket(e.id, _marketConfig(e.micro, v, e.absOiCapUsdg));
            console2.log("scheduled", e.symbol);
        }
        vm.stopBroadcast();
        console2.log("Run applyAll() after 24 hours.");
    }

    function applyAll() external {
        (, Exchange exchange) = _contracts();
        Entry[] memory entries = _entries();
        vm.startBroadcast();
        for (uint256 i; i < entries.length; ++i) {
            exchange.applyMarket(entries[i].id);
            console2.log("applied", entries[i].symbol);
        }
        vm.stopBroadcast();
    }

    // ------------------------------------------------------------------ settings

    function _oracleConfig(Entry memory e) internal view returns (IMarkOracle.OracleConfig memory) {
        return IMarkOracle.OracleConfig({
            chainlinkFeed: e.feed,
            bandBps: 150,
            jumpBps: e.micro ? 3_000 : 2_000,
            maxAgeSec: 180,
            chainlinkMaxAgeSec: e.chainlinkMaxAgeSec,
            liqAgreementBps: 100,
            reanchorConfirmations: 3,
            quorumOutsideBand: uint8(vm.envOr("MARK_QUORUM", uint256(2)))
        });
    }

    /// Defaults from the spec (section 9, "calibrate on tape"), at the R0 leverage ceilings (micro 2x, small 3x).
    function _marketConfig(bool micro, uint256 vUsdg, uint128 absOiCapUsdg) internal pure returns (MarketConfig memory c) {
        c.state = MarketState.Active;
        c.maintenanceMarginBps = micro ? 800 : 500;
        c.maxExecDeviationBps = 500;
        c.maxConfidenceBps = 200;
        c.maxMarkAgeSec = 180;
        c.netSkewBpsOfV = 400;
        c.grossOiBpsOfV = 1_200;
        c.positionBpsOfV = 100;
        c.absOiCapUsdg = absOiCapUsdg; // 1% of the stock's daily dollar volume, from config/market-data.json (0 = no data, no extra cap)
        // A trade from flat to the net-skew cap should pay ~0.75% on average: scale = netCap / (2 * 0.0075).
        c.skewScaleE18 = (vUsdg * c.netSkewBpsOfV / 10_000) * 1e12 * 10_000 / 150;
        c.feeBps = micro ? 12 : 8;
        c.borrowBaseBpsPerHour = 2;
        c.minHoldSec = 60;
        c.fallbackSpreadBps = 100;
        c.frozenSpreadBps = 200;

        //                                   opens  wallet spread maxPos(bps of V) maxLeverage
        c.profiles[1] = SessionProfile(true, false, 0, 100, micro ? 2e18 : 3e18); // Open
        c.profiles[2] = SessionProfile(true, false, 50, 50, micro ? 1.5e18 : 2.5e18); // Extended
        c.profiles[3] = SessionProfile(true, true, 150, 25, micro ? 1.5e18 : 2e18); // Weekend: per-wallet allowance
        c.profiles[4] = SessionProfile(false, false, 200, 0, 0); // Frozen: closes only
        c.profiles[5] = SessionProfile(false, false, 300, 0, 0); // Halted: closes only
    }

    // ------------------------------------------------------------------ files

    function _contracts() internal view returns (MarkOracle oracle, Exchange exchange) {
        string memory dep = vm.readFile("../deployments/4663.json");
        oracle = MarkOracle(vm.parseJsonAddress(dep, ".oracle"));
        exchange = Exchange(vm.parseJsonAddress(dep, ".exchange"));
    }

    /// 1% of the stock's average daily dollar volume, in USDG (6 decimals), from ../config/market-data.json.
    /// Zero when the stock has no row, which leaves only the Counter-based caps. The mark service refuses opens on
    /// markets with no data anyway (see packages/core eligibility).
    function _absOiCap(string memory symbol) internal view returns (uint128) {
        string memory json = vm.readFile("../config/market-data.json");
        string memory key = string.concat(".", symbol, ".avgDailyDollarVolumeUsd");
        if (!vm.keyExists(json, key)) return 0;
        return uint128(vm.parseJsonUint(json, key) * 1e6 / 100);
    }

    function _entries() internal view returns (Entry[] memory out) {
        string memory json = vm.readFile("../config/markets.json");
        // Probe each index: parseJson on ".markets[*]" returns a bare value, not an array, when there is a single market.
        uint256 n;
        while (vm.keyExists(json, string.concat(".markets[", vm.toString(n), "].symbol"))) ++n;
        Entry[] memory tmp = new Entry[](n);
        uint256 count;
        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".markets[", vm.toString(i), "]");
            if (vm.keyExists(json, string.concat(p, ".enabled")) && !vm.parseJsonBool(json, string.concat(p, ".enabled"))) continue;
            Entry memory e;
            e.symbol = vm.parseJsonString(json, string.concat(p, ".symbol"));
            e.micro = keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".class")))) == keccak256("micro");
            e.stockToken = vm.parseJsonAddress(json, string.concat(p, ".stockToken"));
            e.feed = vm.parseJsonAddress(json, string.concat(p, ".chainlinkFeed"));
            string memory ageKey = string.concat(p, ".chainlinkMaxAgeSec");
            e.chainlinkMaxAgeSec = vm.keyExists(json, ageKey) ? uint32(vm.parseJsonUint(json, ageKey)) : 90_000;
            e.absOiCapUsdg = _absOiCap(e.symbol);
            // Must match packages/chain marketIdFor().
            e.id = keccak256(abi.encode("plankton.mkt.v1", e.symbol, e.stockToken));
            tmp[count++] = e;
        }
        out = new Entry[](count);
        for (uint256 i; i < count; ++i) out[i] = tmp[i];
    }
}
