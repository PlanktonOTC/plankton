// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {Exchange} from "../src/Exchange.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";
import {MarketConfig, MarketState, SessionProfile} from "../src/ExchangeTypes.sol";

/// @notice Registers every enabled market from ../config/markets.json on the oracle and the Exchange.
///
/// New markets are live as soon as this lands; on markets already listed, tightenings apply at once and loosenings wait 24h
/// (then anyone can call Exchange.applyMarket):
///   forge script script/ConfigureMarkets.s.sol --sig "schedule()"   --rpc-url <rpc> --broadcast --private-key <owner key>
///
/// The sender of schedule() must be the contracts' owner. Optional env: INITIAL_V_USDG (default 50000e6, the R0 Counter size;
/// 100e6 for the B0 beta)
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
            exchange.scheduleMarket(e.id, _marketConfig(e.micro, v, e.absOiCapUsdg, _isBeta()));
            console2.log("listed", e.symbol);
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
            quorumOutsideBand: uint8(vm.envOr("MARK_QUORUM", uint256(2))),
            // Weekend/Frozen/Halted marks hold a reference price; the mark service republishes on 10 bp moves, so 1% is
            // ample room for one signer and the most a leaked key can move a held mark.
            heldBandBps: 100
        });
    }

    /// Defaults from the spec (section 9, "calibrate on tape"), at the R0 leverage ceilings (micro 2x, small 3x).
    function _marketConfig(bool micro, uint256 vUsdg, uint128 absOiCapUsdg, bool beta)
        internal
        pure
        returns (MarketConfig memory c)
    {
        c.state = MarketState.Active;
        c.maintenanceMarginBps = micro ? 800 : 500;
        c.maxExecDeviationBps = 500;
        c.maxConfidenceBps = 200;
        c.maxMarkAgeSec = 180;
        // B0, the $100 beta: the spec's percentages would allow a $1 position, so caps are 5x wider. The worst case is
        // still the Counter itself, and every cap shrinks back by a tightening (instant) when the Counter grows.
        c.netSkewBpsOfV = beta ? 2_000 : 400;
        c.grossOiBpsOfV = beta ? 6_000 : 1_200;
        c.positionBpsOfV = beta ? 1_000 : 100;
        c.absOiCapUsdg = absOiCapUsdg; // 1% of the stock's daily dollar volume, from config/market-data.json (0 = no data, no extra cap)
        // A trade from flat to the net-skew cap should pay ~0.75% on average: scale = netCap / (2 * 0.0075).
        c.skewScaleE18 = (vUsdg * c.netSkewBpsOfV / 10_000) * 1e12 * 10_000 / 150;
        c.feeBps = micro ? 12 : 8;
        c.borrowBaseBpsPerHour = 2;
        c.minHoldSec = 60;
        c.fallbackSpreadBps = 100;
        c.frozenSpreadBps = 200;

        //                                   opens  wallet spread maxPos(bps of V) maxLeverage
        uint16 k = beta ? 10 : 1; // B0: session ticket caps scale with the wider position cap
        c.profiles[1] = SessionProfile(true, false, 0, 100 * k, micro ? 2e18 : 3e18); // Open
        c.profiles[2] = SessionProfile(true, false, 50, 50 * k, micro ? 1.5e18 : 2.5e18); // Extended
        c.profiles[3] = SessionProfile(true, true, 150, 25 * k, micro ? 1.5e18 : 2e18); // Weekend: per-wallet allowance
        c.profiles[4] = SessionProfile(false, false, 200, 0, 0); // Frozen: closes only
        c.profiles[5] = SessionProfile(false, false, 300, 0, 0); // Halted: closes only

        // Open guard: the first 10 minutes of each Open session (and Monday's reopen),
        // opens pay 15 bp more and are limited to half the normal ticket. Closes are unchanged.
        c.openGuardSec = 600;
        c.openGuardSpreadBps = 15;
        c.openGuardPositionBpsOfV = c.positionBpsOfV / 2;
    }

    // ------------------------------------------------------------------ files

    function _contracts() internal view returns (MarkOracle oracle, Exchange exchange) {
        // DEPLOYMENT_FILE (e.g. deployments/local.json) points a private test chain at its own address book.
        string memory dep = vm.readFile(string.concat("../", vm.envOr("DEPLOYMENT_FILE", string("deployments/4663.json"))));
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

    function _isBeta() internal view returns (bool) {
        return keccak256(bytes(vm.parseJsonString(vm.readFile("../config/markets.json"), ".rung"))) == keccak256("B0");
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
            if (
                vm.keyExists(json, string.concat(p, ".enabled"))
                    && !vm.parseJsonBool(json, string.concat(p, ".enabled"))
            ) continue;
            Entry memory e;
            e.symbol = vm.parseJsonString(json, string.concat(p, ".symbol"));
            e.micro = keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".class")))) == keccak256("micro");
            e.stockToken = vm.parseJsonAddress(json, string.concat(p, ".stockToken"));
            // No feed key: a market Chainlink does not cover. Its oracle config then needs a quorum on every mark.
            string memory feedKey = string.concat(p, ".chainlinkFeed");
            e.feed = vm.keyExists(json, feedKey) ? vm.parseJsonAddress(json, feedKey) : address(0);
            string memory ageKey = string.concat(p, ".chainlinkMaxAgeSec");
            // 6 hours unless the market says otherwise. The band and the liquidation agreement both trust Chainlink only
            // this long, so it must not cover a whole day of a stuck feed.
            e.chainlinkMaxAgeSec = vm.keyExists(json, ageKey) ? uint32(vm.parseJsonUint(json, ageKey)) : 21_600;
            e.absOiCapUsdg = _absOiCap(e.symbol);
            // Must match packages/chain marketIdFor().
            e.id = keccak256(abi.encode("plankton.mkt.v1", e.symbol, e.stockToken));
            tmp[count++] = e;
        }
        out = new Entry[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }
}
