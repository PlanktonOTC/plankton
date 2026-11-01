// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {ExchangeLib} from "../src/ExchangeLib.sol";
import {MarketConfigLib} from "../src/MarketConfigLib.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {CounterVault} from "../src/CounterVault.sol";
import {DelayedUpgrade} from "../src/DelayedUpgrade.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";
import {MarketConfig} from "../src/ExchangeTypes.sol";

/// One test (or more) per finding of the 2026-11-01 contract audit.
contract AuditFixesTest is Base {
    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(bytes32 marketId,address trader,uint8 kind,int256 sizeDeltaE18,uint16 sizeBps,uint256 triggerE18,bool triggerAbove,bool reduceOnly,uint16 maxSlippageBps,uint128 marginUsdg,uint64 validAfter,uint64 expiry,uint64 nonce)"
    );

    // ================================================================== H1: off-session marks hold a Chainlink-set reference

    function test_aLeakedMarkKeyCannotWalkAWeekendMark() public {
        setPrice(100e18);
        // One signer may hold the weekend mark within 1% of Friday's regular close...
        publish(100.9e18, IMarkOracle.Status.Weekend, 25, false);
        // ...but the next step is still measured from that close, not from the last mark, so it cannot walk.
        IMarkOracle.Attestation memory a = attest(101.8e18, IMarkOracle.Status.Weekend, 25);
        bytes[] memory one = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, one);
    }

    function test_frozenAndHaltedHoldTheLastBoundedMarkAndWeekendHoldsTheRegularClose() public {
        setPrice(100e18);
        feed.set(int256(101e8), block.timestamp);
        publish(101e18, IMarkOracle.Status.Extended, 10, false); // after-hours, Chainlink-bounded
        (uint256 close, uint256 bounded,) = oracle.referencesOf(ID);
        assertEq(close, 100e18, "the regular close is set only by Open marks");
        assertEq(bounded, 101e18);

        publish(101.5e18, IMarkOracle.Status.Frozen, 9_999, false); // 0.5% from the last bounded mark
        IMarkOracle.Attestation memory h = attest(99e18, IMarkOracle.Status.Halted, 9_999); // 2% away
        bytes[] memory one = sigs(h, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(h, one);

        publish(100.5e18, IMarkOracle.Status.Weekend, 25, false); // 0.5% from the regular close
        IMarkOracle.Attestation memory w = attest(101.5e18, IMarkOracle.Status.Weekend, 25); // 1.5% from it
        bytes[] memory one2 = sigs(w, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(w, one2);
    }

    function test_aColdStartOffSessionMarkNeedsAQuorum() public {
        bytes32 id2 = keccak256("second market");
        vm.prank(owner);
        oracle.scheduleConfig(id2, oracleConfig());
        IMarkOracle.Attestation memory a = IMarkOracle.Attestation(
            id2,
            100e18,
            100e18,
            25,
            IMarkOracle.Status.Weekend,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp + 120)
        );
        bytes[] memory one = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, one);
        oracle.publish(a, sigs(a, true));
        assertEq(oracle.markOf(id2).priceE18, 100e18);
    }

    function test_widerHeldBandWaitsTwentyFourHours() public {
        IMarkOracle.OracleConfig memory c = oracleConfig();
        c.heldBandBps = 200;
        vm.prank(owner);
        oracle.scheduleConfig(ID, c);
        assertEq(oracle.configOf(ID).heldBandBps, 100);
        skip(24 hours);
        oracle.applyConfig(ID);
        assertEq(oracle.configOf(ID).heldBandBps, 200);
    }

    // ================================================================== H2: the sequence cannot be pushed to the end

    function test_aSequenceJumpIsCapped() public {
        feed.set(int256(100e8), block.timestamp);
        uint64 last = oracle.markOf(ID).sequence;
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        a.sequence = type(uint64).max;
        bytes[] memory sg = sigs(a, true);
        vm.expectRevert(MarkOracle.SequenceGap.selector);
        oracle.publish(a, sg);

        a.sequence = last + oracle.MAX_SEQUENCE_GAP();
        oracle.publish(a, sigs(a, false));
        seq = a.sequence;
        setPrice(100e18); // the market keeps publishing
    }

    // ================================================================== spec: session spreads are charged on-chain

    function test_weekendOpensPayTheWeekendSpread() public {
        publish(100e18, IMarkOracle.Status.Weekend, 25, false);
        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0); // includes the 150 bp weekend spread
        q.execPriceE18 = q.execPriceE18 * 10_100 / 10_150; // only 100 bp
        bytes memory qs = quoteSig(q);
        vm.startPrank(trader);
        exchange.deposit(100e6);
        vm.expectRevert(ExchangeLib.BetterThanSkew.selector);
        exchange.execute(q, qs, 90e6);
        vm.stopPrank();

        open(trader, 1e18, 90e6);
        assertEq(pos(trader).size, 1e18);
    }

    function test_frozenClosesPayTheFrozenSpread() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        publish(100e18, IMarkOracle.Status.Frozen, 9_999, false);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0); // includes the 200 bp frozen spread
        q.execPriceE18 = q.execPriceE18 * 10_000 / 9_800; // without it
        bytes memory qs = quoteSig(q);
        vm.prank(trader);
        vm.expectRevert(ExchangeLib.BetterThanSkew.selector);
        exchange.execute(q, qs, 0);

        reduce(trader, 10_000);
        assertEq(pos(trader).size, 0);
    }

    // ================================================================== M3: leverage on equity

    function test_addingToALosingPositionIsCheckedOnEquity() public {
        open(trader, 5e18, 200e6); // $500 at 2.5x
        nextBlock();
        skip(61);
        setPrice(90e18); // -$50: equity ~$150
        // $540 against $160 of equity is 3.4x, over the 3x cap, though margin alone ($210) would allow it.
        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 200e6);
        vm.startPrank(trader);
        exchange.deposit(200e6);
        vm.expectRevert(ExchangeLib.LeverageTooHigh.selector);
        exchange.execute(q, qs, 10e6);
        exchange.execute(q, qs, 100e6); // enough equity
        vm.stopPrank();
        assertEq(pos(trader).size, 6e18);
    }

    // ================================================================== M1: orders belong to their position

    function _stopLoss(uint64 n) internal view returns (Exchange.Order memory o) {
        o = Exchange.Order({
            marketId: ID,
            trader: trader,
            kind: 3,
            sizeDeltaE18: 0,
            sizeBps: 10_000,
            triggerE18: 95e18,
            triggerAbove: false,
            reduceOnly: true,
            maxSlippageBps: 300,
            marginUsdg: 0,
            validAfter: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 7 days),
            nonce: n
        });
    }

    function _orderSig(Exchange.Order memory o) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.marketId,
                o.trader,
                o.kind,
                o.sizeDeltaE18,
                o.sizeBps,
                o.triggerE18,
                o.triggerAbove,
                o.reduceOnly,
                o.maxSlippageBps,
                o.marginUsdg,
                o.validAfter,
                o.expiry,
                o.nonce
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PlanktonExchange"),
                keccak256("1"),
                block.chainid,
                address(exchange)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(PK_TRADER, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_aStopLossDoesNotOutliveItsPosition() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        bytes memory os_ = _orderSig(o);
        skip(61);
        reduce(trader, 10_000); // closed by hand; the stop-loss is forgotten
        assertEq(exchange.closedAtOf(trader, ID), block.timestamp);

        skip(1 hours);
        setPrice(100e18);
        open(trader, 5e18, 200e6); // a new position
        nextBlock();
        skip(61);
        setPrice(93e18);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(makeAddr("keeper"));
        vm.expectRevert(Exchange.OrderNotActive.selector);
        exchange.executeOrder(o, os_, q, qs);
        assertEq(pos(trader).size, 5e18);
    }

    // ================================================================== M2: the stale exit pays no profit

    function test_closeAtMarkOnAStaleMarkSettlesWithoutProfit() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        skip(61);
        setPrice(110e18); // about +$50
        skip(90_001); // signed mark and Chainlink both stale: the last-mark path
        uint256 before = exchange.collateral(trader);
        vm.prank(trader);
        exchange.closeAtMark(ID, 10_000);
        assertEq(pos(trader).size, 0);
        uint256 back = exchange.collateral(trader) - before;
        assertLe(back, 200e6, "no profit at a stale price");
        assertGt(back, 199e6, "margin less fee and borrow comes back");
    }

    // ================================================================== M4: maintenance changes wait

    function test_raisingMaintenanceMarginWaitsTwentyFourHours() public {
        MarketConfig memory c = marketConfig();
        c.maintenanceMarginBps = 1_000;
        vm.prank(owner);
        exchange.scheduleMarket(ID, c);
        assertEq(exchange.configOf(ID).maintenanceMarginBps, 500, "not applied at once");
        skip(24 hours);
        exchange.applyMarket(ID);
        assertEq(exchange.configOf(ID).maintenanceMarginBps, 1_000);
    }

    function test_fullLeverageMustStartAboveMaintenance() public {
        MarketConfig memory c = marketConfig();
        c.maintenanceMarginBps = 3_500; // a 3x position starts at 33% margin
        vm.prank(owner);
        vm.expectRevert(MarketConfigLib.InvalidMarketConfig.selector);
        exchange.scheduleMarket(ID, c);
    }

    // ================================================================== L2: NAV

    function test_navCountsATraderLossOnlyUpToTheMarginHeld() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        gapTo(50e18); // a $250 loss on $200 of margin
        assertEq(exchange.traderUnrealizedPnlUsdg(), -200e6);
    }

    function test_theVaultDoesNotSettleOnABrokenMark() public {
        open(trader, 5e18, 200e6);
        usdg.mint(lp, 1_000e6);
        vm.prank(lp);
        vault.requestDeposit(1_000e6);
        nextBlock();
        feed.set(int256(130e8), block.timestamp);
        publish(130e18, IMarkOracle.Status.Open, 10, false); // in band but a 30% jump: breaker set
        assertFalse(exchange.navPricesFresh());
        vault.settle(10);
        assertEq(vault.escrowedDeposits(), 1_000e6, "nothing settled on a broken mark");

        gapTo(130e18); // a quorum re-anchors
        vault.settle(10);
        assertEq(vault.escrowedDeposits(), 0);
    }

    // ================================================================== L3: withdrawal dust

    function test_aTinyPartialWithdrawalIsRefused() public {
        vm.prank(lp);
        vm.expectRevert(CounterVault.TooSmall.selector);
        vault.requestWithdraw(1_000);
    }

    // ================================================================== spec: referral rebate

    function test_aReferrerIsPaidTheRebateFirst() public {
        address ref = makeAddr("ref");
        vm.prank(trader);
        exchange.setReferrer(ref);
        Exchange.TradeQuote memory q = open(trader, 5e18, 200e6);
        assertEq(usdg.balanceOf(ref), q.feeUsdg * 10 / 100);

        vm.prank(trader);
        vm.expectRevert(Exchange.AlreadySet.selector);
        exchange.setReferrer(makeAddr("other"));
        vm.prank(makeAddr("self"));
        vm.expectRevert(Exchange.ZeroAddress.selector);
        exchange.setReferrer(makeAddr("self"));
    }

    function test_cuttingTheRebateIsInstantButRaisingItWaits() public {
        vm.startPrank(owner);
        router.setReferralBps(500);
        assertEq(router.referralBps(), 500);
        router.setReferralBps(800);
        vm.stopPrank();
        assertEq(router.referralBps(), 500);
        skip(24 hours);
        router.applyReferralBps();
        assertEq(router.referralBps(), 800);
    }

    // ================================================================== upgrades lapse

    function test_anUnusedUpgradeLapsesAfterSevenDays() public {
        address impl = address(new Exchange());
        vm.prank(owner);
        exchange.scheduleUpgrade(impl);
        skip(48 hours + 7 days + 1);
        vm.prank(owner);
        vm.expectRevert(DelayedUpgrade.UpgradeLapsed.selector);
        exchange.upgradeToAndCall(impl, "");
    }
}

/// The open guard on: 10 minutes, +15 bp, half the ticket.
contract OpenGuardTest is Base {
    function marketConfig() internal pure override returns (MarketConfig memory c) {
        c = Base.marketConfig();
        c.openGuardSec = 600;
        c.openGuardSpreadBps = 15;
        c.openGuardPositionBpsOfV = 50;
    }

    function _reopen() internal {
        publish(100e18, IMarkOracle.Status.Weekend, 25, false);
        skip(10);
        setPrice(100e18);
    }

    function test_theOpenGuardChargesMoreAndHalvesTheTicket() public {
        _reopen();
        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0); // includes the 15 bp guard
        q.execPriceE18 = q.execPriceE18 * 10_000 / 10_015;
        bytes memory qs = quoteSig(q);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.BetterThanSkew.selector);
        exchange.execute(q, qs, 100e6);

        // $600 is over half the 1% ticket ($500) while the guard runs.
        Exchange.TradeQuote memory big = quoteFor(trader, 6e18, 0);
        bytes memory bigSig = quoteSig(big);
        vm.expectRevert(ExchangeLib.PositionTooLarge.selector);
        exchange.execute(big, bigSig, 300e6);
        vm.stopPrank();

        skip(601);
        setPrice(100e18); // still Open: the guard does not restart
        open(trader, 6e18, 300e6);
        assertEq(pos(trader).size, 6e18);
    }

    function test_mondaysReopenRunsTheGuardAgain() public {
        skip(601);
        setPrice(100e18);
        assertEq(requiredSpread(trader, 1e18), 0);
        _reopen();
        assertEq(requiredSpread(trader, 1e18), 15);
    }
}
