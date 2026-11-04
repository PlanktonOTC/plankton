// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";

/// Markets Chainlink does not cover (most sub-$2B names): no on-chain fence, so every mark needs two signers.
contract PennyMarketsTest is Base {
    bytes32 internal constant PENNY = keccak256(abi.encode("plankton.mkt.v1", "RCAT", address(0xCA7)));

    function pennyOracleConfig() internal view returns (IMarkOracle.OracleConfig memory c) {
        c = oracleConfig();
        c.chainlinkFeed = address(0);
    }

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        oracle.scheduleConfig(PENNY, pennyOracleConfig());
        exchange.scheduleMarket(PENNY, marketConfig());
        vm.stopPrank();
        mkt = PENNY;
        publish(PRICE, IMarkOracle.Status.Open, 10, true);
    }

    function test_everyMarkOnAFeedlessMarketNeedsTwoSigners() public {
        IMarkOracle.Attestation memory a = attest(PRICE, IMarkOracle.Status.Open, 10); // unchanged price, still refused
        bytes[] memory one = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, one);

        IMarkOracle.Attestation memory w = attest(PRICE, IMarkOracle.Status.Weekend, 25);
        bytes[] memory oneW = sigs(w, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(w, oneW);

        oracle.publish(a, sigs(a, true));
        assertEq(oracle.markOf(PENNY).sequence, a.sequence);
    }

    function test_aFeedlessMarketMustRequireAtLeastTwoSigners() public {
        IMarkOracle.OracleConfig memory c = pennyOracleConfig();
        c.quorumOutsideBand = 1;
        vm.prank(owner);
        vm.expectRevert(MarkOracle.InvalidConfig.selector);
        oracle.scheduleConfig(keccak256("another penny"), c);
    }

    function test_aPennyPositionOpensClosesAndCanBeLiquidated() public {
        open(trader, 2e18, 100e6); // $200 at 2x
        assertEq(pos(trader).size, 2e18);

        nextBlock();
        publish(52e18, IMarkOracle.Status.Open, 10, true); // -48%: under maintenance, liquidated with no Chainlink check
        vm.prank(keeper);
        exchange.liquidate(trader, PENNY);
        assertEq(pos(trader).size, 0);
    }

    function test_aLosingPennyPositionCanStillExitAtTheMark() public {
        open(trader, 2e18, 100e6);
        nextBlock();
        skip(61);
        publish(95e18, IMarkOracle.Status.Open, 10, true);
        vm.prank(trader);
        exchange.closeAtMark(PENNY, 10_000);
        assertEq(pos(trader).size, 0);
    }

    // ================================================================== LP exits never wait on a mark when the book is flat

    function test_withNoOpenPositionsAnLpWithdrawalSettlesWithoutANewMark() public {
        assertFalse(exchange.hasOpenInterest());
        uint256 shares = vault.balanceOf(lp) / 2;
        uint256 before = usdg.balanceOf(lp);
        vm.prank(lp);
        vault.requestWithdraw(shares);
        skip(30 days); // no mark is ever published again
        vault.settle(10);
        assertGt(usdg.balanceOf(lp), before, "paid out with no new mark");
    }

    function test_withAnOpenPositionAnLpWithdrawalWaitsForTheNextMark() public {
        open(trader, 2e18, 100e6);
        assertTrue(exchange.hasOpenInterest());
        uint256 before = usdg.balanceOf(lp);
        uint256 shares = vault.balanceOf(lp) / 10;
        vm.prank(lp);
        vault.requestWithdraw(shares);
        vault.settle(10);
        assertEq(usdg.balanceOf(lp), before, "waits: NAV can move while a position is open");

        skip(5);
        publish(PRICE, IMarkOracle.Status.Open, 10, true);
        vault.settle(10);
        assertGt(usdg.balanceOf(lp), before);
    }
}
