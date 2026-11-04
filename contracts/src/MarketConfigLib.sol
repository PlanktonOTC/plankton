// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MarketState, SessionProfile, MarketConfig, Market, PendingMarket} from "./ExchangeTypes.sol";

/// @notice Market config rules, in a linked library only to keep Exchange under the 24 KB contract size limit.
/// A new listing and any tightening apply at once; anything that lets traders take more risk on a live market, or charges
/// them more, waits 24h. Raising maintenance margin waits too: applied at once it would let the owner liquidate open
/// positions at will. A new market has no positions yet, so nobody is exposed to its first config.
library MarketConfigLib {
    uint256 internal constant CHANGE_DELAY = 24 hours;

    error InvalidMarketConfig();
    error NothingPending();
    error TooEarly();

    /// List a new market or apply a tightening immediately, or queue a loosening. `created` is true for a new listing.
    function schedule(Market storage d, PendingMarket storage pm, MarketConfig calldata c)
        external
        returns (bool loosening, uint64 eta, bool created)
    {
        validate(c);
        if (!d.exists) {
            d.exists = true;
            d.lastAccrual = uint64(block.timestamp);
            created = true;
        } else if (isLoosening(d.cfg, c)) {
            pm.cfg = c;
            eta = uint64(block.timestamp + CHANGE_DELAY);
            pm.eta = eta;
            return (true, eta, false);
        }
        d.cfg = c;
        delete pm.cfg;
        pm.eta = 0;
        eta = uint64(block.timestamp);
    }

    /// Apply a due loosening.
    function applyPending(Market storage d, PendingMarket storage pm) external {
        if (pm.eta == 0) revert NothingPending();
        if (block.timestamp < pm.eta) revert TooEarly();
        validate(pm.cfg);
        d.cfg = pm.cfg;
        delete pm.cfg;
        pm.eta = 0;
    }

    /// No silent defaults: every session profile that allows opens must say how much leverage and size, and a position
    /// opened at full leverage must start above maintenance margin.
    function validate(MarketConfig memory c) public pure {
        if (
            c.state == MarketState.Unset || c.maintenanceMarginBps == 0 || c.netSkewBpsOfV == 0 || c.grossOiBpsOfV == 0
                || c.positionBpsOfV == 0 || c.skewScaleE18 == 0 || c.maxMarkAgeSec == 0 || c.feeBps > 100
                || (c.openGuardSec != 0 && c.openGuardPositionBpsOfV == 0)
        ) revert InvalidMarketConfig();
        for (uint256 i = 1; i < 6; ++i) {
            SessionProfile memory sp = c.profiles[i];
            if (!sp.opensAllowed) continue;
            if (sp.maxLeverageE18 < 1e18 || sp.maxPositionBpsOfV == 0) revert InvalidMarketConfig();
            if (1e18 * 10_000 / uint256(sp.maxLeverageE18) <= c.maintenanceMarginBps) revert InvalidMarketConfig();
        }
    }

    function isLoosening(MarketConfig storage o, MarketConfig calldata n) public view returns (bool) {
        if (o.state != MarketState.Active && n.state == MarketState.Active) return true;
        if (
            n.maintenanceMarginBps != o.maintenanceMarginBps || n.maxExecDeviationBps > o.maxExecDeviationBps
                || n.maxConfidenceBps > o.maxConfidenceBps || n.maxMarkAgeSec > o.maxMarkAgeSec
                || n.netSkewBpsOfV > o.netSkewBpsOfV || n.grossOiBpsOfV > o.grossOiBpsOfV
                || n.positionBpsOfV > o.positionBpsOfV || n.skewScaleE18 > o.skewScaleE18 || n.feeBps > o.feeBps
                || n.borrowBaseBpsPerHour > o.borrowBaseBpsPerHour || n.minHoldSec < o.minHoldSec
                || n.fallbackSpreadBps > o.fallbackSpreadBps || n.frozenSpreadBps > o.frozenSpreadBps
                || n.openGuardSec < o.openGuardSec || n.openGuardSpreadBps < o.openGuardSpreadBps
                || n.openGuardPositionBpsOfV > o.openGuardPositionBpsOfV
        ) return true;
        if (o.absOiCapUsdg != 0 && (n.absOiCapUsdg == 0 || n.absOiCapUsdg > o.absOiCapUsdg)) return true;
        for (uint256 i = 1; i < 6; ++i) {
            SessionProfile storage a = o.profiles[i];
            SessionProfile calldata b = n.profiles[i];
            if (
                (!a.opensAllowed && b.opensAllowed) || b.maxLeverageE18 > a.maxLeverageE18
                    || b.maxPositionBpsOfV > a.maxPositionBpsOfV || b.extraSpreadBps < a.extraSpreadBps
                    || (a.perWallet && !b.perWallet)
            ) return true;
        }
        return false;
    }
}
