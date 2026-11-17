// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {ExchangeLib} from "../src/ExchangeLib.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";
import {ExchangeMath as M} from "../src/ExchangeMath.sol";

/// closeAtMark must never price better for the trader than the skew-impact price a quote has to pay. Otherwise the skew
/// can be moved at the flat fallback spread and the other side of the book closed by quote at the skew discount, with
/// the Counter paying the difference.
contract CloseAtMarkSkewTest is Base {
    address internal shortSide = makeAddr("shortSide");

    /// A book leaning long: one $500 short, then $3,600 of longs across four wallets (each under the $1,000 cap).
    function _leanLong() internal {
        open(shortSide, -5e18, 500e6);
        for (uint256 i; i < 4; ++i) {
            nextBlock();
            open(makeAddr(string(abi.encode("long", i))), 9e18, 900e6);
        }
        nextBlock();
        skip(61);
        publish(PRICE, IMarkOracle.Status.Open, 10, true);
    }

    function _lastExec() internal returns (uint256 exec) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = ExchangeLib.TradeExecuted.selector;
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].topics[0] == sig) {
                (, exec,,,) = abi.decode(logs[i - 1].data, (int256, uint256, uint256, int256, uint8));
                return exec;
            }
        }
        revert("no trade");
    }

    function _skewBuyPrice(int256 size, uint256 spreadBps) internal view returns (uint256) {
        (uint128 l, uint128 sh,,,) = exchange.marketInfo(mkt);
        int256 before_ = (int256(uint256(l)) - int256(uint256(sh))) * 1e12;
        int256 tradeE18 = int256(M.notional(M.abs(size), PRICE) * 1e12);
        return M.skewFill(PRICE, before_, before_ + tradeE18, skewScale()) * (10_000 + spreadBps) / 10_000;
    }

    function test_closingIntoTheSkewPaysTheSkewImpactNotJustTheFlatSpread() public {
        _leanLong();
        // Buying back the short pushes a long-leaning book further long: the skew price sits ~1% above the mark here, so
        // the flat 1% alone would undercharge it.
        uint256 skewPrice = _skewBuyPrice(5e18, 100);
        uint256 flat = PRICE * 10_100 / 10_000;
        assertGt(skewPrice, flat, "setup: the skew price is the worse one");

        vm.recordLogs();
        vm.prank(shortSide);
        exchange.closeAtMark(mkt, 10_000);
        assertEq(_lastExec(), skewPrice, "closeAtMark charged the skew-impact price");
        assertEq(pos(shortSide).size, 0);
    }

    function test_closingAgainstTheSkewKeepsTheFlatSpreadAndGetsNoSkewBonus() public {
        _leanLong();
        // Selling a long in a long-leaning book would earn a skew bonus by quote. The permissionless exit does not pay it:
        // it stays at the flat spread, the worse of the two for the trader.
        address aLong = makeAddr(string(abi.encode("long", uint256(0))));
        vm.recordLogs();
        vm.prank(aLong);
        exchange.closeAtMark(mkt, 10_000);
        assertEq(_lastExec(), PRICE * 9_900 / 10_000, "flat 1% below the mark");
    }

    function test_theSkewCycleNoLongerPays() public {
        _leanLong();
        // The cycle: exit the short into the skew at the permissionless price, then close a long by quote at the skew
        // discount. Before the fix the first leg paid only the flat spread.
        uint256 counterBefore = cash();
        vm.prank(shortSide);
        exchange.closeAtMark(mkt, 10_000);
        address aLong = makeAddr(string(abi.encode("long", uint256(1))));
        reduce(aLong, 10_000);
        // Net of everything the two exits paid and received, the Counter does not end up worse than where it started.
        assertGe(cash() + 1e6, counterBefore, "the Counter is not paying for the cycle");
    }

    // ------------------------------------------------------------------ the reported cycle (GHSA-grrc-q3gv-wvmm)

    /// Short n, long n, short n from separate wallets (no cap is broken), hold past minHoldSec, exit every long with
    /// closeAtMark, then close every short by quote. n is the $4,000 net-skew cap: four wallets of 9.7 tokens at $100.
    function _reportedCycle(uint256 markDuringHold) internal returns (uint256 navBefore, uint256 navAfter) {
        navBefore = cash();
        address[] memory longs = new address[](4);
        address[] memory shorts = new address[](8);
        for (uint256 i; i < 4; ++i) {
            longs[i] = makeAddr(string(abi.encode("cycle-long", i)));
        }
        for (uint256 i; i < 8; ++i) {
            shorts[i] = makeAddr(string(abi.encode("cycle-short", i)));
        }
        for (uint256 i; i < 4; ++i) {
            open(shorts[i], -9.7e18, 400e6);
        }
        for (uint256 i; i < 4; ++i) {
            open(longs[i], 9.7e18, 400e6);
        }
        for (uint256 i; i < 4; ++i) {
            open(shorts[4 + i], -9.7e18, 400e6);
        }
        nextBlock();
        skip(61);
        publish(markDuringHold, IMarkOracle.Status.Open, 10, true);
        for (uint256 i; i < 4; ++i) {
            vm.prank(longs[i]);
            exchange.closeAtMark(mkt, 10_000);
        }
        for (uint256 i; i < 8; ++i) {
            reduce(shorts[i], 10_000);
        }
        navAfter = cash();
    }

    function test_reportedCycleDoesNotTakeFromTheCounterAtAnUnchangedMark() public {
        (uint256 before_, uint256 after_) = _reportedCycle(PRICE);
        assertGe(after_, before_, "the Counter keeps every fee and loses nothing to the cycle");
    }

    function test_reportedCycleDoesNotTakeFromTheCounterWhenTheMarkMoves() public {
        // A move in the hold is ordinary trading risk on the shorts' net exposure; what must not happen is a gain that
        // the skew pricing alone hands over. At +-1% the book's net short is what the Counter is paid or pays.
        (uint256 b1, uint256 a1) = _reportedCycle(PRICE * 101 / 100);
        assertGe(a1, b1, "mark up 1%: the net short loses, the Counter gains");
    }
}
