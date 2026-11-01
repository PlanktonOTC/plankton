// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {Exchange} from "../src/Exchange.sol";
import {ExchangeLib} from "../src/ExchangeLib.sol";
import {MarketConfigLib} from "../src/MarketConfigLib.sol";
import {DelayedUpgrade} from "../src/DelayedUpgrade.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";
import {MarketConfig, MarketState, Position, SessionProfile} from "../src/ExchangeTypes.sol";
import {PayoutDesk} from "../src/PayoutDesk.sol";
import {ExchangeMath as M} from "../src/ExchangeMath.sol";

contract ExchangeTest is Base {
    address internal keeperAddr = makeAddr("keeper");

    // ================================================================== opening

    function test_openLong_recordsThePositionAndRoutesTheFee() public {
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 backstopBefore = usdg.balanceOf(address(backstop));
        uint256 cashBefore = cash();

        Exchange.TradeQuote memory q = open(trader, 5e18, 200e6);

        Position memory p = pos(trader);
        assertEq(p.size, 5e18);
        assertEq(p.margin, 200e6);
        assertGe(p.entry, 100e18, "a buy never fills below the mark");
        (uint128 longOI,,,,) = exchange.marketInfo(ID);
        assertApproxEqAbs(longOI, 500e6, 1e6);
        assertEq(exchange.collateral(trader), 0, "margin and fee both left the collateral account");

        // Fee split v1: Counter 75%, Backstop 20%, treasury 5%.
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, q.feeUsdg * 5 / 100);
        assertEq(usdg.balanceOf(address(backstop)) - backstopBefore, q.feeUsdg * 20 / 100);
        assertEq(cash() - cashBefore, q.feeUsdg - q.feeUsdg * 5 / 100 - q.feeUsdg * 20 / 100);
    }

    function test_openShort() public {
        open(trader, -5e18, 200e6);
        assertEq(pos(trader).size, -5e18);
        (, uint128 shortOI,,,) = exchange.marketInfo(ID);
        assertApproxEqAbs(shortOI, 500e6, 1e6);
    }

    function test_aFilledBuyIsNeverBetterThanTheSkewPrice() public {
        // With the book already long, a further buy must pay more than the bare mark.
        open(makeAddr("whale"), 9e18, 400e6);
        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0);
        assertGt(q.execPriceE18, 100e18);
    }

    function test_onePermitDepositAndOpenInOneTransaction() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0);
        bytes memory qs = quoteSig(q);
        uint256 amount = 200e6 + q.feeUsdg;
        uint256 deadline = block.timestamp + 600;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                trader,
                address(exchange),
                amount,
                usdg.nonces(trader),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_TRADER, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));

        vm.prank(trader);
        usdg.approve(address(exchange), 0); // no standing approval: the permit must do the work
        vm.prank(trader);
        exchange.permitAndExecute(amount, deadline, v, r, s, q, qs, 200e6);
        assertEq(pos(trader).size, 5e18);
    }

    function test_aFrontRunPermitDoesNotBlockTheTrade() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0);
        bytes memory qs = quoteSig(q);
        uint256 amount = 200e6 + q.feeUsdg;
        // The permit signature is garbage and the allowance is already set: the trade must still go through.
        vm.prank(trader);
        usdg.approve(address(exchange), amount);
        vm.prank(trader);
        exchange.permitAndExecute(amount, block.timestamp + 600, 27, bytes32(uint256(1)), bytes32(uint256(2)), q, qs, 200e6);
        assertEq(pos(trader).size, 5e18);
    }

    // ================================================================== quote checks

    function test_quoteForAnotherTraderIsRejected() public {
        Exchange.TradeQuote memory q = quoteFor(makeAddr("someoneElse"), 5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.expectRevert(Exchange.WrongTrader.selector);
        vm.prank(trader);
        exchange.execute(q, qs, 200e6);
    }

    function test_expiredQuoteIsRejected() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0);
        bytes memory qs = quoteSig(q);
        skip(61);
        vm.expectRevert(Exchange.QuoteExpired.selector);
        vm.prank(trader);
        exchange.execute(q, qs, 200e6);
    }

    function test_aQuoteWorksOnlyOnce() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 2e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        exchange.execute(q, qs, 100e6);
        vm.expectRevert(Exchange.NonceUsed.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();
    }

    function test_cancelQuotesBeforeKillsOlderQuotes() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 2e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(trader);
        exchange.cancelQuotesBefore(q.nonce + 1);
        vm.expectRevert(Exchange.NonceUsed.selector);
        vm.prank(trader);
        exchange.execute(q, qs, 100e6);
    }

    function test_quoteSignedByAnUnlistedKeyIsRejected() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 2e18, 0);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 execPriceE18,uint256 feeUsdg,uint64 maxLeverageE18,uint64 markSequence,uint64 nonce,uint64 expiry)"),
                q.marketId, q.trader, q.sizeDeltaE18, q.execPriceE18, q.feeUsdg, q.maxLeverageE18, q.markSequence, q.nonce, q.expiry
            )
        );
        bytes32 domain = keccak256(
            abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("PlanktonExchange"), keccak256("1"), block.chainid, address(exchange))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(Exchange.BadSigner.selector);
        exchange.execute(q, abi.encodePacked(r, s, v), 100e6);
        vm.stopPrank();
    }

    function test_aPriceFarFromTheMarkIsRejectedEvenIfSigned() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0);
        q.execPriceE18 = 110e18; // 10% above the mark, beyond the 5% limit
        q.feeUsdg = M.notional(5e18, q.execPriceE18) * 8 / 10_000;
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.ExecDeviation.selector);
        exchange.execute(q, qs, 200e6);
        vm.stopPrank();
    }

    function test_aBuyBelowTheSkewPriceIsRejected() public {
        open(makeAddr("whale"), 9e18, 400e6); // book is long, so buying costs a premium
        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0);
        q.execPriceE18 = 100e18; // the bare mark: better than the skew price allows
        q.feeUsdg = M.notional(1e18, q.execPriceE18) * 8 / 10_000;
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.BetterThanSkew.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();
    }

    function test_feeOutsideTheAllowedRangeIsRejected() public {
        Exchange.TradeQuote memory low = quoteFor(trader, 5e18, 0);
        low.feeUsdg = 0;
        bytes memory lowSig = quoteSig(low);
        Exchange.TradeQuote memory high = quoteFor(trader, 5e18, 0);
        high.feeUsdg = M.notional(5e18, high.execPriceE18) * 700 / 10_000; // 7%: above fee + deviation
        bytes memory highSig = quoteSig(high);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.BadFee.selector);
        exchange.execute(low, lowSig, 200e6);
        vm.expectRevert(ExchangeLib.BadFee.selector);
        exchange.execute(high, highSig, 200e6);
        vm.stopPrank();
    }

    // ================================================================== limits on opening

    function test_leverageAboveTheProfileLimitIsRejected() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0); // $500 notional
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.LeverageTooHigh.selector);
        exchange.execute(q, qs, 100e6); // 5x against a 3x limit
        vm.stopPrank();
    }

    function test_aQuoteCannotRaiseItsOwnLeverageLimit() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 5e18, 0);
        q.maxLeverageE18 = 10e18; // above the on-chain profile
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.LeverageTooHigh.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();
    }

    function test_aPositionLargerThanOnePercentOfTheCounterIsRejected() public {
        Exchange.TradeQuote memory q = quoteFor(trader, 11e18, 0); // $1,100 against a $1,000 limit
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.PositionTooLarge.selector);
        exchange.execute(q, qs, 500e6);
        vm.stopPrank();
    }

    function test_netSkewCapStopsTheFifthLongButNotAShort() public {
        for (uint256 i; i < 4; ++i) open(makeAddr(string.concat("long", vm.toString(i))), 9.5e18, 400e6); // 4 x ~$960 = ~$3,800
        address fifth = makeAddr("long4");
        Exchange.TradeQuote memory q = quoteFor(fifth, 9.5e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(fifth, 1_000e6);
        vm.startPrank(fifth);
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.SkewCap.selector);
        exchange.execute(q, qs, 400e6);
        vm.stopPrank();

        open(makeAddr("short0"), -9.5e18, 400e6); // balances the book, so it is allowed
    }

    function test_grossOpenInterestCap() public {
        // 6 longs and 6 shorts of ~$990 keep the book balanced but use up $11,880 of the $12,000 gross cap.
        for (uint256 i; i < 6; ++i) {
            open(makeAddr(string.concat("L", vm.toString(i))), 9.9e18, 400e6);
            open(makeAddr(string.concat("S", vm.toString(i))), -9.9e18, 400e6);
        }
        address extra = makeAddr("extra");
        Exchange.TradeQuote memory q = quoteFor(extra, 2e18, 0); // $200 more would pass $12,000
        bytes memory qs = quoteSig(q);
        usdg.mint(extra, 1_000e6);
        vm.startPrank(extra);
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.GrossCap.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();
    }

    function test_capacityShrinksAsTheBookFills() public {
        (uint256 longBefore, uint256 shortBefore) = exchange.capacity(ID);
        assertEq(longBefore, 4_000e6);
        assertEq(shortBefore, 4_000e6);
        open(trader, 9.9e18, 400e6);
        (uint256 longAfter, uint256 shortAfter) = exchange.capacity(ID);
        assertApproxEqAbs(longAfter, 4_000e6 - 990e6, 2e6);
        assertApproxEqAbs(shortAfter, 4_990e6, 2e6, "a long book leaves more room for shorts");
    }

    // ================================================================== market states and sessions

    function test_frozenSessionBlocksOpensButNotCloses() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        publish(100e18, IMarkOracle.Status.Frozen, 9_999, false);

        Exchange.TradeQuote memory openQ = quoteFor(makeAddr("late"), 1e18, 200);
        bytes memory openSig = quoteSig(openQ);
        usdg.mint(makeAddr("late"), 1_000e6);
        vm.startPrank(makeAddr("late"));
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.SessionClosed.selector);
        exchange.execute(openQ, openSig, 100e6);
        vm.stopPrank();

        // Closing still works, and pays the frozen spread (200 bps).
        Exchange.TradeQuote memory closeQ = quoteFor(trader, -5e18, 200);
        bytes memory closeSig = quoteSig(closeQ);
        vm.prank(trader);
        exchange.execute(closeQ, closeSig, 0);
        assertEq(pos(trader).size, 0);
    }

    function test_lowConfidenceBlocksOpensButNotCloses() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        publish(100e18, IMarkOracle.Status.Open, 300, false); // 3% uncertainty, above the 2% limit

        Exchange.TradeQuote memory q = quoteFor(makeAddr("late"), 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(makeAddr("late"), 1_000e6);
        vm.startPrank(makeAddr("late"));
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.LowConfidence.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();

        reduce(trader, 10_000); // exit is unaffected
        assertEq(pos(trader).size, 0);
    }

    function test_theBreakerBlocksOpens() public {
        feed.set(int256(70e8), block.timestamp);
        publish(70e18, IMarkOracle.Status.Open, 10, false); // 30% gap, one signer: breaker set
        assertTrue(oracle.markOf(ID).breaker);

        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 1_000e6);
        vm.startPrank(trader);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.BreakerSet.selector);
        exchange.execute(q, qs, 50e6);
        vm.stopPrank();
    }

    function test_aStaleMarkBlocksQuotedTradesButCloseAtMarkStillExits() public {
        open(trader, 5e18, 200e6);
        skip(181); // older than maxMarkAgeSec
        Exchange.TradeQuote memory q = quoteFor(makeAddr("late"), 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(makeAddr("late"), 1_000e6);
        vm.startPrank(makeAddr("late"));
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.StaleMark.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();

        // A quote priced off a stale mark cannot close either; the backend-free exit can.
        nextBlock();
        Exchange.TradeQuote memory closeQ = quoteFor(trader, -5e18, 0);
        bytes memory closeSig = quoteSig(closeQ);
        vm.prank(trader);
        vm.expectRevert(ExchangeLib.StaleMark.selector);
        exchange.execute(closeQ, closeSig, 0);

        vm.prank(trader);
        exchange.closeAtMark(ID, 10_000);
        assertEq(pos(trader).size, 0);
    }

    function test_weekendLimitsAreBothLeverageAndPerWalletSize() public {
        publish(100e18, IMarkOracle.Status.Weekend, 25, false);
        // Weekend allowance: 0.25% of V = $250 per wallet, 2x leverage, +150 bps spread.
        open(trader, 2e18, 120e6); // $200 at 1.67x: fine
        assertEq(pos(trader).size, 2e18);

        Exchange.TradeQuote memory q = quoteFor(trader, 1e18, 150); // a further $100 takes the wallet to $300
        bytes memory qs = quoteSig(q);
        usdg.mint(trader, 500e6);
        vm.startPrank(trader);
        exchange.deposit(500e6);
        vm.expectRevert(ExchangeLib.WalletLimit.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();
    }

    function test_aCloseOnlyMarketAcceptsOnlyReduces() public {
        open(trader, 5e18, 200e6);
        vm.prank(guardian);
        exchange.guardianSetState(ID, MarketState.CloseOnly);

        Exchange.TradeQuote memory q = quoteFor(makeAddr("late"), 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(makeAddr("late"), 1_000e6);
        vm.startPrank(makeAddr("late"));
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.NotActive.selector);
        exchange.execute(q, qs, 100e6);
        vm.stopPrank();

        reduce(trader, 10_000);
        assertEq(pos(trader).size, 0);
    }

    // ================================================================== reducing, profit and loss

    function test_reducingInTheSameBlockIsRefused() public {
        open(trader, 5e18, 200e6);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.expectRevert(ExchangeLib.SameBlockReduce.selector);
        vm.prank(trader);
        exchange.execute(q, qs, 0);
    }

    function test_partialCloseReturnsTheMatchingShareOfMargin() public {
        open(trader, 5e18, 200e6);
        reduce(trader, 5_000);
        Position memory p = pos(trader);
        assertEq(p.size, 2.5e18);
        assertEq(p.margin, 100e6);
        assertGt(exchange.collateral(trader), 90e6, "about half the margin came back");
    }

    function test_aProfitableCloseIsPaidByTheCounter() public {
        open(trader, 5e18, 200e6);
        skip(61); // past the minimum hold
        setPrice(110e18);
        uint256 cashBefore = cash();
        reduce(trader, 10_000);
        // 5 tokens x ~$10 = ~$50 of profit, less the spread and fee on exit.
        assertGt(exchange.collateral(trader), 200e6 + 40e6);
        assertLt(cash(), cashBefore, "the Counter paid");
    }

    function test_aLosingCloseGoesToTheCounter() public {
        open(trader, 5e18, 200e6);
        skip(61);
        setPrice(90e18);
        uint256 cashBefore = cash();
        reduce(trader, 10_000);
        assertLt(exchange.collateral(trader), 200e6 - 40e6);
        assertGt(cash(), cashBefore, "the Counter was paid");
    }

    function test_aQuickProfitIsCappedByTheMinimumHold() public {
        open(trader, 5e18, 200e6);
        setPrice(110e18); // only a couple of seconds after opening
        reduce(trader, 10_000);
        // Uncapped it would be ~$50; capped at 25 bp of the ~$550 notional it is about $1.4.
        assertLt(exchange.collateral(trader), 200e6 + 5e6);
    }

    function test_flippingFromLongToShortInOneTrade() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        usdg.mint(trader, 500e6);
        vm.prank(trader);
        exchange.deposit(500e6);
        Exchange.TradeQuote memory q = quoteFor(trader, -8e18, 0); // closes 5, opens a 3 short
        bytes memory qs = quoteSig(q);
        vm.prank(trader);
        exchange.execute(q, qs, 150e6);
        assertEq(pos(trader).size, -3e18);
        assertEq(pos(trader).margin, 150e6, "the old margin was released, the new position starts fresh");
    }

    // ================================================================== the exit that needs no backend

    function test_closeAtMarkWorksWithNoQuoteAtAll() public {
        open(trader, 5e18, 200e6);
        skip(200); // our signed marks have stopped coming (older than the 180 s limit)
        feed.set(int256(100e8), block.timestamp); // but Chainlink is alive
        nextBlock();
        vm.prank(trader);
        exchange.closeAtMark(ID, 10_000);
        assertEq(pos(trader).size, 0);
        assertGt(exchange.collateral(trader), 150e6, "returned minus a spread and fee");
    }

    function test_closeAtMarkStillWorksWhenEverythingIsStale() public {
        open(trader, 5e18, 200e6);
        skip(100_000); // signed mark and Chainlink both old
        nextBlock();
        vm.prank(trader);
        exchange.closeAtMark(ID, 10_000); // last mark at the 200 bps frozen spread
        assertEq(pos(trader).size, 0);
    }

    function test_closeAtMarkWorksWhileTheMarketIsPausedOrHalted() public {
        open(trader, 5e18, 200e6);
        nextBlock();
        publish(100e18, IMarkOracle.Status.Halted, 9_999, false);
        vm.prank(guardian);
        exchange.guardianSetState(ID, MarketState.Paused);
        vm.prank(trader);
        exchange.closeAtMark(ID, 5_000);
        assertEq(pos(trader).size, 2.5e18);
    }

    function test_closeAtMarkCannotOpenOrCloseSomeoneElse() public {
        vm.prank(trader);
        vm.expectRevert(ExchangeLib.NoPosition.selector);
        exchange.closeAtMark(ID, 10_000);
    }

    // ================================================================== liquidation

    function _openLiquidatable() internal {
        open(trader, 5e18, 170e6); // $500 at 2.94x; liquidatable once equity < 5% of notional, around $69
    }

    function test_aHealthyPositionCannotBeLiquidated() public {
        _openLiquidatable();
        vm.prank(keeperAddr);
        vm.expectRevert(ExchangeLib.NotLiquidatable.selector);
        exchange.liquidate(trader, ID);
    }

    function test_liquidationPaysThePenaltyAndReturnsTheRemainder() public {
        _openLiquidatable();
        setPrice(85e18);
        setPrice(72e18);
        setPrice(68e18);
        uint256 backstopBefore = usdg.balanceOf(address(backstop));

        vm.prank(keeperAddr);
        exchange.liquidate(trader, ID);

        assertEq(pos(trader).size, 0);
        // Margin $170: penalty is 5% = $8.50, half to the liquidator and half to the Backstop Fund.
        assertApproxEqAbs(usdg.balanceOf(keeperAddr), 4.25e6, 0.1e6);
        assertApproxEqAbs(usdg.balanceOf(address(backstop)) - backstopBefore, 4.25e6, 0.1e6);
        // Equity was about $10, so about $1.5 comes back to the trader.
        assertApproxEqAbs(exchange.collateral(trader), 1.5e6, 1.5e6);
        (uint128 longOI,,,,) = exchange.marketInfo(ID);
        assertEq(longOI, 0, "open interest is released");
    }

    function test_liquidationIsBlockedWhileFrozenOrWhenTheSourcesDisagree() public {
        _openLiquidatable();
        setPrice(85e18);
        setPrice(72e18);
        setPrice(68e18);

        // Chainlink says $68.9 while our mark says $68: 1.3% apart, past the 1% liquidation agreement.
        feed.set(int256(68.9e8), block.timestamp);
        vm.prank(keeperAddr);
        vm.expectRevert(ExchangeLib.LiquidationBlocked.selector);
        exchange.liquidate(trader, ID);

        feed.set(int256(68e8), block.timestamp);
        publish(68e18, IMarkOracle.Status.Frozen, 9_999, false);
        vm.prank(keeperAddr);
        vm.expectRevert(ExchangeLib.LiquidationBlocked.selector);
        exchange.liquidate(trader, ID);
    }

    function test_liquidationIsBlockedWhileTheBreakerIsSet() public {
        _openLiquidatable();
        feed.set(int256(60e8), block.timestamp);
        publish(60e18, IMarkOracle.Status.Open, 10, false); // one signer on a 40% gap: breaker
        vm.prank(keeperAddr);
        vm.expectRevert(ExchangeLib.LiquidationBlocked.selector);
        exchange.liquidate(trader, ID);
    }

    function test_aGapBeyondTheMarginBecomesBadDebtAndBlocksOpens() public {
        _openLiquidatable();
        gapTo(60e18); // two signers confirm a 40% gap: equity is about -$30
        vm.prank(keeperAddr);
        exchange.liquidate(trader, ID);

        (,,,, uint128 badDebt) = exchange.marketInfo(ID);
        assertApproxEqAbs(badDebt, 30e6, 1.5e6);
        assertEq(exchange.totalBadDebt(), badDebt);

        Exchange.TradeQuote memory q = quoteFor(makeAddr("late"), 1e18, 0);
        bytes memory qs = quoteSig(q);
        usdg.mint(makeAddr("late"), 1_000e6);
        vm.startPrank(makeAddr("late"));
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(1_000e6);
        vm.expectRevert(ExchangeLib.BadDebtBlocked.selector);
        exchange.execute(q, qs, 50e6);
        vm.stopPrank();

        // The team pays it back and the market reopens.
        usdg.mint(address(this), badDebt);
        usdg.approve(address(exchange), badDebt);
        exchange.recapitalise(ID, badDebt);
        (,,,, uint128 after_) = exchange.marketInfo(ID);
        assertEq(after_, 0);
    }

    function test_theBackstopFundAbsorbsAGapBeforeLpsDo() public {
        usdg.mint(address(backstop), 100e6);
        _openLiquidatable();
        uint256 navBefore = vault.navUsdg();
        gapTo(60e18);
        vm.prank(keeperAddr);
        exchange.liquidate(trader, ID);

        (,,,, uint128 badDebt) = exchange.marketInfo(ID);
        assertEq(badDebt, 0, "fully covered, nothing left for LPs");
        assertLt(usdg.balanceOf(address(backstop)), 100e6 + 10e6, "the Backstop paid in");
        assertGe(vault.navUsdg() + 1e6, navBefore - 1e6, "LPs were made whole");
    }

    function test_theFirstLossTrancheComesAfterTheBackstop() public {
        usdg.mint(address(backstop), 10e6); // not enough alone
        usdg.mint(address(firstLoss), 100e6);
        _openLiquidatable();
        gapTo(60e18);
        vm.prank(keeperAddr);
        exchange.liquidate(trader, ID);
        (,,,, uint128 badDebt) = exchange.marketInfo(ID);
        assertEq(badDebt, 0);
        assertLt(usdg.balanceOf(address(firstLoss)), 100e6, "First-Loss paid the remainder");
    }

    // ================================================================== trigger orders

    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(bytes32 marketId,address trader,uint8 kind,int256 sizeDeltaE18,uint16 sizeBps,uint256 triggerE18,bool triggerAbove,bool reduceOnly,uint16 maxSlippageBps,uint128 marginUsdg,uint64 validAfter,uint64 expiry,uint64 nonce)"
    );

    function _stopLoss(uint64 n) internal view returns (Exchange.Order memory o) {
        o = Exchange.Order({
            marketId: ID,
            trader: trader,
            kind: 3, // stop-loss
            sizeDeltaE18: 0,
            sizeBps: 10_000,
            triggerE18: 95e18,
            triggerAbove: false,
            reduceOnly: true,
            maxSlippageBps: 300,
            marginUsdg: 0,
            validAfter: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 1 days),
            nonce: n
        });
    }

    function _orderSig(Exchange.Order memory o) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(ORDER_TYPEHASH, o.marketId, o.trader, o.kind, o.sizeDeltaE18, o.sizeBps, o.triggerE18, o.triggerAbove, o.reduceOnly, o.maxSlippageBps, o.marginUsdg, o.validAfter, o.expiry, o.nonce)
        );
        bytes32 domain = keccak256(
            abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("PlanktonExchange"), keccak256("1"), block.chainid, address(exchange))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_TRADER, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_aStopLossFiresOnlyOnceThePriceReachesIt() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        bytes memory os_ = _orderSig(o);

        nextBlock();
        Exchange.TradeQuote memory early = quoteFor(trader, -5e18, 0);
        bytes memory earlySig = quoteSig(early);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.TriggerNotMet.selector);
        exchange.executeOrder(o, os_, early, earlySig);

        skip(61);
        setPrice(93e18);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(keeperAddr);
        exchange.executeOrder(o, os_, q, qs);
        assertEq(pos(trader).size, 0, "the keeper closed it on the trader's behalf");
    }

    function test_anOrderRunsOnlyOnce() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        bytes memory os_ = _orderSig(o);
        skip(61);
        setPrice(93e18);
        nextBlock();
        Exchange.TradeQuote memory q1 = quoteFor(trader, -2.5e18, 0);
        o.sizeBps = 5_000; // sign a half-close order instead
        os_ = _orderSig(o);
        bytes memory q1s = quoteSig(q1);
        vm.prank(keeperAddr);
        exchange.executeOrder(o, os_, q1, q1s);

        Exchange.TradeQuote memory q2 = quoteFor(trader, -1.25e18, 0);
        bytes memory q2s = quoteSig(q2);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.NonceUsed.selector);
        exchange.executeOrder(o, os_, q2, q2s);
    }

    function test_theTraderCanCancelAnOrderOnChain() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(7);
        bytes memory os_ = _orderSig(o);
        vm.prank(trader);
        exchange.cancelOrder(7);
        skip(61);
        setPrice(93e18);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.NonceUsed.selector);
        exchange.executeOrder(o, os_, q, qs);
    }

    function test_anOrderCannotBeBentByTheKeeper() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        bytes memory os_ = _orderSig(o);
        skip(61);
        setPrice(93e18);
        // The keeper tries to close a different amount than the trader signed.
        Exchange.TradeQuote memory q = quoteFor(trader, -2e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.OrderMismatch.selector);
        exchange.executeOrder(o, os_, q, qs);
    }

    function test_anOrderSignedByAnotherKeyIsRejected() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        o.trader = makeAddr("victim"); // keeper claims the order belongs to someone else
        bytes memory os_ = _orderSig(o); // signed by the trader's key, not the victim's
        Exchange.TradeQuote memory q = quoteFor(makeAddr("victim"), -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.BadSigner.selector);
        exchange.executeOrder(o, os_, q, qs);
    }

    function test_anExpiredOrderIsRefused() public {
        open(trader, 5e18, 200e6);
        Exchange.Order memory o = _stopLoss(1);
        bytes memory os_ = _orderSig(o);
        skip(2 days);
        setPrice(93e18);
        Exchange.TradeQuote memory q = quoteFor(trader, -5e18, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(keeperAddr);
        vm.expectRevert(Exchange.OrderNotActive.selector);
        exchange.executeOrder(o, os_, q, qs);
    }

    // ================================================================== borrow

    function test_theCrowdedSidePaysBorrowOverTime() public {
        address crowded = makeAddr("L0");
        open(crowded, 9.5e18, 400e6);
        for (uint256 i = 1; i < 4; ++i) open(makeAddr(string.concat("L", vm.toString(i))), 9.5e18, 400e6); // net ~ $3,800 of a $4,000 cap

        uint256 marginBefore = pos(crowded).margin;
        skip(1 hours);
        setPrice(100e18);
        uint256 cashBefore = cash();
        reduce(crowded, 100); // touching the position settles the borrow owed

        // ~$960 notional at ~1.8 bps/hour (2 bps x 0.95 squared) when the book is nearly at its skew cap = ~$0.17.
        uint256 expectedMargin = marginBefore - marginBefore / 100 - 0.17e6;
        assertApproxEqAbs(pos(crowded).margin, expectedMargin, 0.06e6);
        assertGt(cash(), cashBefore, "borrow goes to the Counter");
    }

    // ================================================================== market config

    function test_aNewMarketWaitsTwentyFourHours() public {
        bytes32 id2 = keccak256("second");
        vm.prank(owner);
        exchange.scheduleMarket(id2, marketConfig());
        // The oracle must know it first.
        vm.expectRevert(Exchange.OracleNotConfigured.selector);
        exchange.applyMarket(id2);

        vm.prank(owner);
        oracle.scheduleConfig(id2, oracleConfig());
        vm.expectRevert(MarketConfigLib.TooEarly.selector);
        exchange.applyMarket(id2);
        skip(24 hours);
        exchange.applyMarket(id2);
        assertEq(exchange.marketCount(), 2);
    }

    function test_looseningAMarketWaitsButTighteningIsImmediate() public {
        MarketConfig memory c = exchange.configOf(ID);
        c.netSkewBpsOfV = 800; // looser
        vm.prank(owner);
        exchange.scheduleMarket(ID, c);
        assertEq(exchange.configOf(ID).netSkewBpsOfV, 400, "not yet");

        MarketConfig memory t = exchange.configOf(ID);
        t.netSkewBpsOfV = 200; // tighter
        vm.prank(owner);
        exchange.scheduleMarket(ID, t);
        assertEq(exchange.configOf(ID).netSkewBpsOfV, 200, "immediate, and it cancels the queued loosening");

        skip(24 hours);
        vm.expectRevert(MarketConfigLib.NothingPending.selector);
        exchange.applyMarket(ID);
    }

    function test_theGuardianCanOnlyTightenAndCancelsQueuedLoosening() public {
        MarketConfig memory c = exchange.configOf(ID);
        c.netSkewBpsOfV = 800;
        vm.prank(owner);
        exchange.scheduleMarket(ID, c);

        vm.prank(guardian);
        vm.expectRevert(Exchange.BadState.selector);
        exchange.guardianSetState(ID, MarketState.Active); // cannot reopen

        vm.prank(guardian);
        exchange.guardianSetState(ID, MarketState.Paused);
        assertEq(uint8(exchange.configOf(ID).state), uint8(MarketState.Paused));
        skip(24 hours);
        vm.expectRevert(MarketConfigLib.NothingPending.selector);
        exchange.applyMarket(ID); // the queued loosening was cancelled

        vm.prank(makeAddr("random"));
        vm.expectRevert(Exchange.NotGuardian.selector);
        exchange.guardianSetState(ID, MarketState.CloseOnly);
    }

    function test_aMarketMustSpecifyItsSessionProfiles() public {
        MarketConfig memory c = marketConfig();
        c.profiles[1].maxLeverageE18 = 0; // opens allowed but no leverage given
        vm.prank(owner);
        vm.expectRevert(MarketConfigLib.InvalidMarketConfig.selector);
        exchange.scheduleMarket(keccak256("x"), c);
    }

    function test_atMostSixtyFourMarkets() public {
        vm.startPrank(owner);
        for (uint256 i = 1; i < 64; ++i) {
            bytes32 id2 = keccak256(abi.encode("m", i));
            oracle.scheduleConfig(id2, oracleConfig());
            exchange.scheduleMarket(id2, marketConfig());
        }
        bytes32 extra = keccak256("extra");
        oracle.scheduleConfig(extra, oracleConfig());
        exchange.scheduleMarket(extra, marketConfig());
        vm.stopPrank();
        skip(24 hours);
        for (uint256 i = 1; i < 64; ++i) exchange.applyMarket(keccak256(abi.encode("m", i)));
        assertEq(exchange.marketCount(), 64);
        vm.expectRevert(Exchange.TooManyMarkets.selector);
        exchange.applyMarket(extra);
    }

    function test_quoteSignersFollowTheSameDelayRules() public {
        address newSigner = makeAddr("newSigner");
        vm.prank(owner);
        exchange.setQuoteSigner(newSigner, true);
        assertFalse(exchange.isQuoteSigner(newSigner));
        vm.expectRevert(Exchange.TooEarly.selector);
        exchange.applyQuoteSigner(newSigner);
        skip(24 hours);
        exchange.applyQuoteSigner(newSigner);
        assertTrue(exchange.isQuoteSigner(newSigner));
        vm.prank(owner);
        exchange.setQuoteSigner(newSigner, false);
        assertFalse(exchange.isQuoteSigner(newSigner), "removal is instant");
    }

    function test_upgradesWaitFortyEightHours() public {
        address newImpl = address(new Exchange());
        vm.prank(owner);
        exchange.scheduleUpgrade(newImpl);
        vm.prank(owner);
        vm.expectRevert(DelayedUpgrade.UpgradeTooEarly.selector);
        exchange.upgradeToAndCall(newImpl, "");
        skip(48 hours);
        vm.prank(owner);
        exchange.upgradeToAndCall(newImpl, "");
    }

    // ================================================================== accounts

    function test_freeCollateralCanAlwaysBeWithdrawn() public {
        usdg.mint(trader, 500e6);
        vm.startPrank(trader);
        exchange.deposit(500e6);
        exchange.withdraw(500e6);
        vm.expectRevert(Exchange.InsufficientCollateral.selector);
        exchange.withdraw(1);
        vm.stopPrank();
    }

    function test_marginCanBeAddedToAnOpenPosition() public {
        open(trader, 5e18, 200e6);
        usdg.mint(trader, 100e6);
        vm.startPrank(trader);
        exchange.deposit(100e6);
        exchange.addMargin(ID, 100e6);
        vm.stopPrank();
        assertEq(pos(trader).margin, 300e6);
    }

    // ================================================================== money is never created or lost

    /// The Exchange holds exactly the traders' free collateral plus their position margins: nothing else.
    function _assertExchangeSolvent() internal view {
        assertEq(usdg.balanceOf(address(exchange)), exchange.collateral(trader) + pos(trader).margin, "exchange balance == collateral + margin");
    }

    function testFuzz_roundTripKeepsTheExchangeSolvent(uint256 sizeSeed, uint256 movePct, bool long) public {
        uint256 size = bound(sizeSeed, 1e17, 9e18); // up to $900, inside every limit
        int256 move = int256(bound(movePct, 0, 40)) - 20; // -20%..+20%
        int256 signedSize = long ? int256(size) : -int256(size);
        uint128 margin = uint128(M.notional(size, 100e18) * 40 / 100 + 1e6); // ~2.5x leverage

        open(trader, signedSize, margin);
        _assertExchangeSolvent();

        skip(61);
        uint256 newPrice = uint256(int256(100e18) + (int256(100e18) * move) / 100);
        if (newPrice == 0) newPrice = 80e18;
        setPrice(newPrice);

        nextBlock();
        int256 delta = -signedSize;
        Exchange.TradeQuote memory q = quoteFor(trader, delta, 0);
        bytes memory qs = quoteSig(q);
        vm.prank(trader);
        exchange.execute(q, qs, 0);
        _assertExchangeSolvent();
        assertEq(pos(trader).size, 0);

        // Whatever the trader did, the pool never ends with negative NAV from one small trade.
        assertGt(vault.navUsdg(), 90_000e6);
    }
}

/// Larger limits, so one trade can earn more than 2% of the Counter in an hour and exercise the payout desk.
contract ExchangePayoutTest is Base {
    function marketConfig() internal pure override returns (MarketConfig memory c) {
        c.state = MarketState.Active;
        c.maintenanceMarginBps = 500;
        c.maxExecDeviationBps = 500;
        c.maxConfidenceBps = 200;
        c.maxMarkAgeSec = 180;
        c.netSkewBpsOfV = 3_000;
        c.grossOiBpsOfV = 6_000;
        c.positionBpsOfV = 3_000;
        c.skewScaleE18 = uint256(30_000e6) * 1e12 * 10_000 / 150;
        c.feeBps = 8;
        c.borrowBaseBpsPerHour = 2;
        c.minHoldSec = 60;
        c.fallbackSpreadBps = 100;
        c.frozenSpreadBps = 200;
        c.profiles[1] = SessionProfile(true, false, 0, 3_000, 3e18);
        c.profiles[2] = SessionProfile(true, false, 50, 3_000, 2.5e18);
        c.profiles[3] = SessionProfile(true, true, 150, 3_000, 2e18);
        c.profiles[4] = SessionProfile(false, false, 200, 0, 0);
        c.profiles[5] = SessionProfile(false, false, 300, 0, 0);
    }

    function test_profitAboveTwoPercentOfTheCounterPerHourIsPaidLate() public {
        address whale = makeAddr("whale");
        open(whale, 130e18, 4_400e6); // $13,000 notional
        skip(61);
        setPrice(120e18); // +20%: about $2,600 of profit, but only 2% of $100,000 = $2,000 may be paid this hour

        uint256 cashBefore = cash();
        reduce(whale, 10_000);

        uint256 owed = desk.outstanding();
        assertGt(owed, 400e6, "the excess became an IOU");
        assertLt(owed, 800e6);
        // Margin is never delayed: the full $4,400 came back at once, plus the $2,000 paid now.
        assertGt(exchange.collateral(whale), 4_400e6 + 1_900e6);
        // The limit is 2% of the Counter's current value, which already fell by the trader's open profit: ~$1,950.
        assertApproxEqAbs(cashBefore - cash(), 1_940e6, 25e6);
        assertEq(vault.navUsdg() + owed, cash(), "NAV already subtracts what the Counter owes");
    }

    function test_aDeferredPayoutCanBeClaimedAfterTheDelayAndFrozenByTheGuardian() public {
        address whale = makeAddr("whale");
        open(whale, 130e18, 4_400e6);
        skip(61);
        setPrice(120e18);
        reduce(whale, 10_000);
        uint256 owed = desk.outstanding();

        vm.expectRevert(PayoutDesk.NotClaimable.selector);
        desk.claim(1); // too early

        skip(1 hours);
        vm.prank(guardian);
        desk.freeze(1, uint64(block.timestamp + 10 hours));
        vm.expectRevert(PayoutDesk.NotClaimable.selector);
        desk.claim(1);

        skip(10 hours);
        uint256 before_ = usdg.balanceOf(whale);
        desk.claim(1);
        assertEq(usdg.balanceOf(whale) - before_, owed, "paid to the trader, whoever triggered the claim");
        assertEq(desk.outstanding(), 0);
    }

    function test_theGuardianCannotFreezeAClaimForever() public {
        address whale = makeAddr("whale");
        open(whale, 130e18, 4_400e6);
        skip(61);
        setPrice(120e18);
        reduce(whale, 10_000);
        (, , uint64 claimableAt,,) = desk.claims(1);
        vm.prank(guardian);
        vm.expectRevert(PayoutDesk.BadFreeze.selector);
        desk.freeze(1, claimableAt + 73 hours);
    }
}
