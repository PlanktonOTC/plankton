// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {Position} from "../src/ExchangeTypes.sol";
import {ExchangeMath as M} from "../src/ExchangeMath.sol";

/// Random sequences of opens, partial closes and price moves by three traders. After every step the books must add up.
contract ExchangeBookkeepingTest is Base {
    address[3] internal actors;

    function setUp() public override {
        super.setUp();
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
    }

    function _roll(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _tryOpen(address who, int256 size, uint128 margin) internal {
        Exchange.TradeQuote memory q = quoteFor(who, size, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(who, margin + q.feeUsdg);
        vm.startPrank(who);
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(margin + q.feeUsdg);
        try exchange.execute(q, qs, margin) {} catch {}
        vm.stopPrank();
    }

    function _tryReduce(address who, uint16 bps) internal {
        nextBlock();
        int256 size = pos(who).size;
        if (size == 0) return;
        Exchange.TradeQuote memory q = quoteFor(who, M.fractionClose(size, bps), 0);
        bytes memory qs = quoteSig(q);
        vm.prank(who);
        try exchange.execute(q, qs, 0) {} catch {}
    }

    /// 1. Open interest equals the sum of the positions' entry notionals, to rounding dust.
    /// 2. The Exchange holds exactly what it owes traders: free collateral plus position margins.
    /// 3. The running net-exposure total matches the book.
    function _assertBooksAddUp(uint256 stepsDone) internal view {
        uint256 longSum;
        uint256 shortSum;
        uint256 owed;
        for (uint256 i; i < 3; ++i) {
            Position memory p = pos(actors[i]);
            owed += exchange.collateral(actors[i]) + p.margin;
            uint256 n = M.notional(M.abs(p.size), p.entry);
            if (p.size > 0) longSum += n;
            else if (p.size < 0) shortSum += n;
        }
        (uint128 longOI, uint128 shortOI,,,) = exchange.marketInfo(ID);
        uint256 dust = 3 * (stepsDone + 1); // a unit or so of rounding per trade
        assertApproxEqAbs(longOI, longSum, dust, "long open interest matches the positions");
        assertApproxEqAbs(shortOI, shortSum, dust, "short open interest matches the positions");
        assertEq(usdg.balanceOf(address(exchange)), owed, "exchange holds exactly collateral plus margins");
        uint256 net = longOI > shortOI ? longOI - shortOI : shortOI - longOI;
        assertEq(exchange.totalAbsNet(), net, "net exposure total matches");
    }

    function testFuzz_booksAlwaysAddUp(uint256 seed) public {
        uint256 price = 100e18;
        for (uint256 step; step < 10; ++step) {
            uint256 r = _roll(seed, step);
            address who = actors[r % 3];
            uint256 action = (r >> 8) % 5;

            if (action <= 1) {
                // open, or add to a position, long or short, up to ~$900
                uint256 size = bound(r >> 16, 1e17, 9e18);
                int256 signed_ = ((r >> 40) % 2 == 0) ? int256(size) : -int256(size);
                _tryOpen(who, signed_, uint128(M.notional(size, price) * 45 / 100 + 1e6));
            } else if (action <= 3) {
                _tryReduce(who, uint16(bound(r >> 24, 500, 10_000)));
            } else {
                // a small price move, within the band, with time for the minimum hold to pass
                skip(61);
                int256 pct = int256(bound(r >> 32, 0, 6)) - 3; // -3%..+3%
                price = uint256(int256(price) + int256(price) * pct / 100);
                setPrice(price);
            }
            _assertBooksAddUp(step + 1);
        }

        // Everyone leaves: nothing is stranded.
        for (uint256 i; i < 3; ++i) {
            if (pos(actors[i]).size != 0) {
                skip(61);
                setPrice(price);
                _tryReduce(actors[i], 10_000);
            }
        }
        _assertBooksAddUp(20);
    }
}
