// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMarkOracle} from "./interfaces/Interfaces.sol";
import {MarketState, SessionProfile, Market, Position, Trade, State} from "./ExchangeTypes.sol";
import {ExchangeMath as M} from "./ExchangeMath.sol";

/// @notice The trade engine: opening, reducing, flipping, liquidating and the exit path. It runs by delegatecall on
/// the Exchange's own storage (a linked library), which keeps the Exchange itself under the 24 KB contract size limit.
/// Money always moves from and to the Exchange's own USDG balance.
library ExchangeLib {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = M.BPS;
    uint256 private constant E18 = M.E18;
    uint256 private constant USDG_SCALE = M.USDG_SCALE;
    uint256 private constant TOTAL_NET_BPS = 2_000; // all-markets net exposure: 20% of V
    uint256 private constant GLOBAL_BAD_DEBT_BPS = 200; // 2% of V
    uint256 private constant PROFIT_LIMIT_BPS = 200; // realised trader profit per hour: 2% of V
    uint256 private constant MIN_HOLD_PROFIT_CAP_BPS = 25;
    uint256 private constant LIQ_PENALTY_BPS = 500; // of margin: half to the liquidator, half to the Backstop Fund
    uint256 private constant RESERVE_BPS = 5_000; // cash the Counter keeps against its net exposure

    event TradeExecuted(
        address indexed trader,
        bytes32 indexed marketId,
        int256 sizeDeltaE18,
        uint256 priceE18,
        uint256 feeUsdg,
        int256 realizedPnlUsdg,
        uint8 path // 0 quote, 1 order, 2 closeAtMark, 3 liquidation
    );
    event PositionUpdated(address indexed trader, bytes32 indexed marketId, int256 sizeE18, uint256 entryE18, uint256 marginUsdg);
    event Liquidated(address indexed trader, bytes32 indexed marketId, uint256 markE18, uint256 penaltyUsdg, address liquidator);
    event BadDebt(bytes32 indexed marketId, uint256 amountUsdg);
    event BadDebtCovered(bytes32 indexed marketId, uint256 amountUsdg);
    event ProfitDeferred(address indexed trader, uint256 amountUsdg, uint64 claimableAt);

    error UnknownMarket();
    error NoMark();
    error FutureMark();
    error ZeroSize();
    error InsufficientCollateral();
    error MarginRequired();
    error NoPosition();
    error SameBlockReduce();
    error NotActive();
    error Deleveraging();
    error BreakerSet();
    error SessionClosed();
    error StaleMark();
    error LowConfidence();
    error BadDebtBlocked();
    error LeverageTooHigh();
    error PositionTooLarge();
    error WalletLimit();
    error SkewCap();
    error GrossCap();
    error TotalNetCap();
    error ExecDeviation();
    error BetterThanSkew();
    error BadFee();
    error NotLiquidatable();
    error LiquidationBlocked();
    error NotReducing();

    // ================================================================== entry points

    function applyTrade(State storage s, Trade memory t) external {
        _applyTrade(s, t);
    }

    /// Permissionless exit for the trader's own position. Reduce-only, at the on-chain mark less a published spread.
    /// Price source order: fresh signed mark, then fresh Chainlink, then the last mark at the frozen spread.
    /// It is a safety exit, not a good fill.
    function closeAtMark(State storage s, address trader, bytes32 marketId, uint16 sizeBps) external {
        Market storage d = s.markets[marketId];
        if (!d.exists) revert UnknownMarket();
        Position storage p = s.positions[trader][marketId];
        if (p.size == 0) revert NoPosition();
        if (sizeBps == 0 || sizeBps > BPS) revert ZeroSize();

        int256 delta = M.fractionClose(p.size, sizeBps);
        (uint256 price, uint256 spread) = _fallbackPrice(s, marketId, d);
        uint256 exec = price * (p.size > 0 ? BPS - spread : BPS + spread) / BPS;
        uint256 fee = M.notional(M.abs(delta), exec) * d.cfg.feeBps / BPS;
        _applyTrade(s, Trade(trader, marketId, delta, exec, fee, 0, 0, 0, 2, false));
    }

    /// Permissionless. Open/Extended need the signed mark and a fresh Chainlink answer to agree. Weekend liquidates on
    /// margin only, at the held mark. Frozen, Halted and a set breaker block liquidation.
    function liquidate(State storage s, address trader, bytes32 marketId, address liquidator) external {
        Market storage d = s.markets[marketId];
        if (!d.exists) revert UnknownMarket();
        Position storage p = s.positions[trader][marketId];
        if (p.size == 0) revert NoPosition();

        IMarkOracle.Mark memory mk = s.oracle.markOf(marketId);
        _requireLiquidationWindow(s, marketId, d, mk);

        uint256 V = s.vault.navUsdg();
        _accrue(d, V);
        uint256 netBefore = _absNet(d);
        _settleBorrow(s, d, p, marketId);

        uint256 size = M.abs(p.size);
        bool isLong = p.size > 0;
        int256 pnl = M.pnl(isLong, p.entry, mk.priceE18, size);
        uint256 margin = p.margin;
        int256 equity = int256(margin) + pnl;
        if (equity >= int256(M.notional(size, mk.priceE18) * d.cfg.maintenanceMarginBps / BPS)) revert NotLiquidatable();

        uint256 penalty = equity > 0 ? M.min(uint256(equity), margin * LIQ_PENALTY_BPS / BPS) : 0;
        uint256 toTrader = equity > int256(penalty) ? uint256(equity) - penalty : 0;

        _removeFromBooks(s, d, trader, isLong, size, p.entry);
        delete s.positions[trader][marketId];
        s.totalAbsNet = s.totalAbsNet - netBefore + _absNet(d);

        // The Exchange holds `margin` for this position. Pay the penalty and the trader's remainder; the rest settles with the Counter.
        uint256 toLiquidator = penalty / 2;
        if (toLiquidator > 0) s.usdg.safeTransfer(liquidator, toLiquidator);
        if (penalty - toLiquidator > 0) s.usdg.safeTransfer(address(s.backstop), penalty - toLiquidator);
        s.collateral[trader] += toTrader;
        int256 vaultDelta = int256(margin) - int256(penalty) - int256(toTrader);
        if (vaultDelta > 0) s.usdg.safeTransfer(address(s.vault), uint256(vaultDelta));
        else if (vaultDelta < 0) s.vault.payOut(address(this), uint256(-vaultDelta));
        if (equity < 0) _bad(s, marketId, d, uint256(-equity));

        emit TradeExecuted(trader, marketId, isLong ? -int256(size) : int256(size), mk.priceE18, penalty, pnl, 3);
        emit Liquidated(trader, marketId, mk.priceE18, penalty, liquidator);
        emit PositionUpdated(trader, marketId, 0, 0, 0);
    }

    /// Anyone (in practice the team) can pay a market's uncovered shortfall back into the Counter.
    function recapitalise(State storage s, bytes32 marketId, uint256 amount, address from) external {
        Market storage d = s.markets[marketId];
        if (!d.exists) revert UnknownMarket();
        s.usdg.safeTransferFrom(from, address(s.vault), amount);
        uint256 cleared = M.min(amount, d.badDebt);
        d.badDebt -= uint128(cleared);
        s.totalBadDebt -= cleared;
        emit BadDebtCovered(marketId, cleared);
    }

    // ================================================================== views

    /// Room left on each side, in USDG notional, from net skew and gross OI caps against the Counter's NAV.
    function capacity(State storage s, bytes32 marketId) external view returns (uint256 longRoomUsdg, uint256 shortRoomUsdg) {
        Market storage d = s.markets[marketId];
        if (s.vault.deleveraging()) return (0, 0);
        uint256 V = s.vault.navUsdg();
        int256 net = int256(uint256(d.longOI)) - int256(uint256(d.shortOI));
        int256 netCap = int256(V * d.cfg.netSkewBpsOfV / BPS);
        uint256 gross = uint256(d.longOI) + d.shortOI;
        uint256 grossCap = _grossCap(d, V);
        uint256 grossRoom = grossCap > gross ? grossCap - gross : 0;
        int256 l = netCap - net;
        int256 sh = netCap + net;
        longRoomUsdg = M.min(l > 0 ? uint256(l) : 0, grossRoom);
        shortRoomUsdg = M.min(sh > 0 ? uint256(sh) : 0, grossRoom);
    }

    /// Sum of all mark sequences: advances whenever any mark is published. The vault settles requests on it.
    function markEpoch(State storage s) external view returns (uint256 epoch) {
        for (uint256 i; i < s.marketIds.length; ++i) epoch += s.oracle.markOf(s.marketIds[i]).sequence;
    }

    /// Trader profit (positive) or loss (negative) on all open positions at the last marks. The vault subtracts it from NAV.
    function traderUnrealizedPnl(State storage s) external view returns (int256 total) {
        for (uint256 i; i < s.marketIds.length; ++i) {
            Market storage d = s.markets[s.marketIds[i]];
            uint256 price = s.oracle.markOf(s.marketIds[i]).priceE18;
            if (price == 0) continue;
            total += int256(M.notional(d.longSize, price)) - int256(uint256(d.longOI));
            total += int256(uint256(d.shortOI)) - int256(M.notional(d.shortSize, price));
        }
    }

    /// Cash the Counter must keep against its net exposure; not available for withdrawals.
    function counterReserve(State storage s) external view returns (uint256 reserve) {
        for (uint256 i; i < s.marketIds.length; ++i) reserve += _absNet(s.markets[s.marketIds[i]]);
        reserve = reserve * RESERVE_BPS / BPS;
    }

    // ================================================================== the trade

    /// Opens, increases, reduces, closes or flips a position. Everything a trade does to money happens here.
    function _applyTrade(State storage s, Trade memory t) private {
        Market storage d = s.markets[t.id];
        if (!d.exists) revert UnknownMarket();
        uint256 absDelta = M.abs(t.delta);
        if (absDelta == 0) revert ZeroSize();

        IMarkOracle.Mark memory mk = s.oracle.markOf(t.id);
        if (t.checkPrice) {
            if (mk.priceE18 == 0) revert NoMark();
            if (t.markSeq > mk.sequence) revert FutureMark();
        }

        uint256 V = s.vault.navUsdg();
        _accrue(d, V);
        uint256 netBefore = _absNet(d);

        Position storage p = s.positions[t.trader][t.id];
        uint256 closeSize;
        uint256 openSize;
        if (p.size != 0 && (p.size > 0) != (t.delta > 0)) {
            closeSize = M.min(M.abs(p.size), absDelta);
            openSize = absDelta - closeSize;
        } else {
            openSize = absDelta;
        }
        if (openSize > 0 && !t.checkPrice) revert NotReducing(); // the fallback exit can only reduce

        SessionProfile memory prof = d.cfg.profiles[uint8(mk.status)];
        if (t.checkPrice) _checkPrice(d, mk, t, absDelta, openSize == 0);
        if (openSize > 0) _checkOpenPre(s, d, mk, prof, V);

        if (p.size != 0) _settleBorrow(s, d, p, t.id);

        uint256 credit;
        int256 realized;
        if (closeSize > 0) (credit, realized) = _reduce(s, d, p, t, closeSize, V);
        if (openSize > 0) _increase(s, d, p, t, openSize);

        // The trader's account: margin goes in, fee comes out, released margin and profit come back.
        uint256 marginIn = openSize > 0 ? t.margin : 0;
        if (openSize > 0 && marginIn == 0) revert MarginRequired();
        uint256 avail = s.collateral[t.trader] + credit;
        uint256 feePaid;
        if (openSize > 0) {
            if (avail < marginIn + t.fee) revert InsufficientCollateral();
            feePaid = t.fee;
        } else {
            feePaid = M.min(t.fee, avail); // an exit is never blocked by an unpaid fee
        }
        s.collateral[t.trader] = avail - marginIn - feePaid;
        if (feePaid > 0) s.feeRouter.route(feePaid, address(0));

        if (openSize > 0) _checkOpenPost(s, d, p, prof, t, V, netBefore);
        s.totalAbsNet = s.totalAbsNet - netBefore + _absNet(d);

        emit TradeExecuted(t.trader, t.id, t.delta, t.exec, feePaid, realized, t.path);
        emit PositionUpdated(t.trader, t.id, p.size, p.entry, p.margin);
        if (p.size == 0) delete s.positions[t.trader][t.id];
    }

    function _reduce(State storage s, Market storage d, Position storage p, Trade memory t, uint256 closeSize, uint256 V)
        private
        returns (uint256 credit, int256 pnl)
    {
        if (p.openedBlock == block.number) revert SameBlockReduce();
        uint256 absOld = M.abs(p.size);
        bool isLong = p.size > 0;

        pnl = M.pnl(isLong, p.entry, t.exec, closeSize);
        if (pnl > 0 && block.timestamp < uint256(p.openedAt) + d.cfg.minHoldSec) {
            uint256 cap = M.notional(closeSize, t.exec) * MIN_HOLD_PROFIT_CAP_BPS / BPS;
            if (uint256(pnl) > cap) pnl = int256(cap);
        }

        uint256 released = uint256(p.margin) * closeSize / absOld;
        p.margin -= uint128(released);
        _removeFromBooks(s, d, t.trader, isLong, closeSize, p.entry);
        p.size += isLong ? -int256(closeSize) : int256(closeSize);

        if (pnl > 0) {
            credit = released + _payProfit(s, t.trader, uint256(pnl), V);
        } else {
            uint256 loss = uint256(-pnl);
            uint256 paid = M.min(loss, released);
            credit = released - paid;
            if (paid > 0) s.usdg.safeTransfer(address(s.vault), paid);
            if (loss > paid) _bad(s, t.id, d, loss - paid);
        }
    }

    function _increase(State storage s, Market storage d, Position storage p, Trade memory t, uint256 openSize) private {
        bool buy = t.delta > 0;
        int256 signed = buy ? int256(openSize) : -int256(openSize);
        if (p.size == 0) {
            p.entry = t.exec;
            p.size = signed;
            p.margin = uint128(t.margin);
        } else {
            uint256 absOld = M.abs(p.size);
            p.entry = (absOld * p.entry + openSize * t.exec) / (absOld + openSize);
            p.size += signed;
            p.margin += uint128(t.margin);
        }
        p.openedAt = uint64(block.timestamp);
        p.openedBlock = uint64(block.number);
        p.borrowSnap = buy ? d.longIdx : d.shortIdx;

        uint256 notional = M.notional(openSize, t.exec);
        if (buy) {
            d.longOI += uint128(notional);
            d.longSize += uint128(openSize);
        } else {
            d.shortOI += uint128(notional);
            d.shortSize += uint128(openSize);
        }
        s.walletNotional[t.trader] += notional;
    }

    function _removeFromBooks(State storage s, Market storage d, address trader, bool isLong, uint256 size, uint256 entry)
        private
    {
        uint256 notional = M.notional(size, entry);
        if (isLong) {
            d.longOI = M.sub128(d.longOI, notional);
            d.longSize = M.sub128(d.longSize, size);
        } else {
            d.shortOI = M.sub128(d.shortOI, notional);
            d.shortSize = M.sub128(d.shortSize, size);
        }
        uint256 w = s.walletNotional[trader];
        s.walletNotional[trader] = w > notional ? w - notional : 0;
    }

    // ================================================================== checks

    function _checkPrice(Market storage d, IMarkOracle.Mark memory mk, Trade memory t, uint256 absDelta, bool reducingOnly)
        private
        view
    {
        uint256 mark = mk.priceE18;
        uint256 maxDev = d.cfg.maxExecDeviationBps;
        if (
            reducingOnly
                && (mk.status == IMarkOracle.Status.Frozen || mk.status == IMarkOracle.Status.Halted || d.cfg.state != MarketState.Active)
        ) {
            maxDev += d.cfg.frozenSpreadBps; // closes in frozen/halted/close-only states pay the frozen spread
        }
        if (M.diffBps(t.exec, mark) > maxDev) revert ExecDeviation();

        // The quote may never be better for the trader than the skew-impact price (SIP-279 style).
        int256 skewBefore = (int256(uint256(d.longOI)) - int256(uint256(d.shortOI))) * int256(USDG_SCALE);
        int256 tradeE18 = int256(M.notional(absDelta, mark) * USDG_SCALE) * (t.delta > 0 ? int256(1) : int256(-1));
        uint256 fill = M.skewFill(mark, skewBefore, skewBefore + tradeE18, d.cfg.skewScaleE18);
        if (t.delta > 0 ? t.exec < fill : t.exec > fill) revert BetterThanSkew();

        uint256 notional = M.notional(absDelta, t.exec);
        if (t.fee < notional * d.cfg.feeBps / BPS || t.fee > notional * (d.cfg.feeBps + d.cfg.maxExecDeviationBps) / BPS) {
            revert BadFee();
        }
    }

    function _checkOpenPre(State storage s, Market storage d, IMarkOracle.Mark memory mk, SessionProfile memory prof, uint256 V)
        private
        view
    {
        if (d.cfg.state != MarketState.Active) revert NotActive();
        if (s.vault.deleveraging()) revert Deleveraging();
        if (mk.breaker) revert BreakerSet();
        if (!prof.opensAllowed) revert SessionClosed();
        if (block.timestamp > uint256(mk.updatedAt) + d.cfg.maxMarkAgeSec) revert StaleMark();
        if (mk.confidenceBps > d.cfg.maxConfidenceBps) revert LowConfidence();
        if (d.badDebt > 0 || s.totalBadDebt > V * GLOBAL_BAD_DEBT_BPS / BPS) revert BadDebtBlocked();
    }

    function _checkOpenPost(
        State storage s,
        Market storage d,
        Position storage p,
        SessionProfile memory prof,
        Trade memory t,
        uint256 V,
        uint256 netBefore
    ) private view {
        uint256 posNotional = M.notional(M.abs(p.size), t.exec);
        if (t.maxLev == 0 || t.maxLev > prof.maxLeverageE18) revert LeverageTooHigh();
        if (posNotional * E18 > uint256(p.margin) * t.maxLev) revert LeverageTooHigh();

        if (posNotional > V * d.cfg.positionBpsOfV / BPS) revert PositionTooLarge();
        if (prof.perWallet) {
            if (s.walletNotional[t.trader] > V * prof.maxPositionBpsOfV / BPS) revert WalletLimit();
        } else if (posNotional > V * prof.maxPositionBpsOfV / BPS) {
            revert PositionTooLarge();
        }

        // Caps bind unless the trade reduced the skew (so a falling NAV never traps a balancing trade).
        uint256 netAfter = _absNet(d);
        if (netAfter > V * d.cfg.netSkewBpsOfV / BPS && netAfter >= netBefore) revert SkewCap();
        if (uint256(d.longOI) + d.shortOI > _grossCap(d, V)) revert GrossCap();
        if (s.totalAbsNet - netBefore + netAfter > V * TOTAL_NET_BPS / BPS && netAfter >= netBefore) revert TotalNetCap();
    }

    function _requireLiquidationWindow(State storage s, bytes32 marketId, Market storage d, IMarkOracle.Mark memory mk)
        private
        view
    {
        if (mk.breaker || mk.priceE18 == 0) revert LiquidationBlocked();
        if (block.timestamp > uint256(mk.updatedAt) + d.cfg.maxMarkAgeSec) revert LiquidationBlocked();
        if (mk.status == IMarkOracle.Status.Open || mk.status == IMarkOracle.Status.Extended) {
            IMarkOracle.OracleConfig memory oc = s.oracle.configOf(marketId);
            (uint256 cl, uint64 clAt) = s.oracle.chainlinkPrice(marketId);
            if (clAt == 0 || block.timestamp > uint256(clAt) + oc.chainlinkMaxAgeSec) revert LiquidationBlocked();
            if (M.diffBps(mk.priceE18, cl) > oc.liqAgreementBps) revert LiquidationBlocked();
        } else if (mk.status != IMarkOracle.Status.Weekend) {
            revert LiquidationBlocked(); // Frozen, Halted, Unset
        }
    }

    // ================================================================== money

    /// Pays a realised profit now up to the hourly limit (2% of V) and what the vault holds in cash; the rest becomes an IOU.
    function _payProfit(State storage s, address trader, uint256 profit, uint256 V) private returns (uint256 paidNow) {
        uint256 hour = block.timestamp / 1 hours;
        uint256 limit = V * PROFIT_LIMIT_BPS / BPS;
        uint256 used = s.profitInHour[hour];
        paidNow = M.min(M.min(profit, limit > used ? limit - used : 0), s.vault.cashUsdg());
        s.profitInHour[hour] = used + paidNow;
        if (paidNow > 0) s.vault.payOut(address(this), paidNow);
        uint256 deferred = profit - paidNow;
        if (deferred > 0) {
            uint64 claimableAt = s.payoutDesk.defer(trader, deferred);
            emit ProfitDeferred(trader, deferred, claimableAt);
        }
    }

    /// Loss waterfall: the market's own bad-debt bucket (stops opens), then the Backstop Fund, then the First-Loss tranche.
    /// Whatever is left is borne by Counter LPs and stays in the bucket until recapitalised.
    function _bad(State storage s, bytes32 marketId, Market storage d, uint256 shortfall) private {
        d.badDebt += uint128(shortfall);
        s.totalBadDebt += shortfall;
        emit BadDebt(marketId, shortfall);
        uint256 covered = s.backstop.cover(marketId, shortfall);
        if (covered < shortfall) covered += s.firstLoss.absorb(shortfall - covered);
        if (covered > 0) {
            d.badDebt -= uint128(covered);
            s.totalBadDebt -= covered;
            emit BadDebtCovered(marketId, covered);
        }
    }

    /// Borrow owed since the last settlement comes out of margin and goes to the Counter.
    function _settleBorrow(State storage s, Market storage d, Position storage p, bytes32 marketId) private {
        uint256 idx = p.size > 0 ? d.longIdx : d.shortIdx;
        uint256 owed = M.notional(M.abs(p.size), p.entry) * (idx - p.borrowSnap) / E18;
        p.borrowSnap = idx;
        if (owed == 0) return;
        uint256 take = M.min(owed, p.margin);
        p.margin -= uint128(take);
        if (take > 0) s.usdg.safeTransfer(address(s.vault), take);
        if (owed > take) _bad(s, marketId, d, owed - take);
    }

    /// Dominant side pays base * (net / maxNet)^2 per hour. Past 80% of the gross cap both sides pay at least base
    /// (hedged pairs no longer sit on capacity for free).
    function _accrue(Market storage d, uint256 V) private {
        uint64 last = d.lastAccrual;
        d.lastAccrual = uint64(block.timestamp);
        if (last == 0 || block.timestamp == last) return;
        uint256 base = uint256(d.cfg.borrowBaseBpsPerHour) * 1e14;
        if (base == 0) return;

        uint256 dt = block.timestamp - last;
        uint256 longOI = d.longOI;
        uint256 shortOI = d.shortOI;
        uint256 netAbs = longOI > shortOI ? longOI - shortOI : shortOI - longOI;
        uint256 maxNet = V * d.cfg.netSkewBpsOfV / BPS;
        uint256 dominant = maxNet == 0 ? base : base * M.min(netAbs, maxNet) ** 2 / (maxNet * maxNet);
        bool minApplies = (longOI + shortOI) * 10 > _grossCap(d, V) * 8;
        uint256 other;
        if (minApplies) {
            if (dominant < base) dominant = base;
            other = base;
        }
        if (longOI > shortOI) {
            d.longIdx += dominant * dt / 1 hours;
            d.shortIdx += other * dt / 1 hours;
        } else if (shortOI > longOI) {
            d.shortIdx += dominant * dt / 1 hours;
            d.longIdx += other * dt / 1 hours;
        } else if (minApplies) {
            d.longIdx += base * dt / 1 hours;
            d.shortIdx += base * dt / 1 hours;
        }
    }

    /// Mark source order for `closeAtMark`: fresh signed mark, fresh Chainlink, last mark. Frozen and stale cases pay the frozen spread.
    function _fallbackPrice(State storage s, bytes32 marketId, Market storage d)
        private
        view
        returns (uint256 price, uint256 spread)
    {
        IMarkOracle.Mark memory mk = s.oracle.markOf(marketId);
        spread = d.cfg.fallbackSpreadBps;
        bool signedFresh = mk.priceE18 != 0 && block.timestamp <= uint256(mk.updatedAt) + d.cfg.maxMarkAgeSec
            && mk.status != IMarkOracle.Status.Unset;
        if (signedFresh) {
            price = mk.priceE18;
        } else {
            (uint256 cl, uint64 clAt) = s.oracle.chainlinkPrice(marketId);
            if (clAt != 0 && block.timestamp <= uint256(clAt) + s.oracle.configOf(marketId).chainlinkMaxAgeSec) {
                price = cl;
            } else {
                price = mk.priceE18;
                spread = d.cfg.frozenSpreadBps;
            }
        }
        if (mk.status == IMarkOracle.Status.Frozen || mk.status == IMarkOracle.Status.Halted) {
            spread = M.max(spread, d.cfg.frozenSpreadBps);
        }
        if (price == 0) revert NoMark();
    }

    function _absNet(Market storage d) private view returns (uint256) {
        uint256 l = d.longOI;
        uint256 sh = d.shortOI;
        return l > sh ? l - sh : sh - l;
    }

    function _grossCap(Market storage d, uint256 V) private view returns (uint256 cap) {
        cap = V * d.cfg.grossOiBpsOfV / BPS;
        uint256 absCap = d.cfg.absOiCapUsdg;
        if (absCap != 0 && absCap < cap) cap = absCap;
    }
}
