// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CounterVault} from "../src/CounterVault.sol";
import {DelayedUpgrade} from "../src/DelayedUpgrade.sol";
import {PayoutDesk} from "../src/PayoutDesk.sol";
import {ICounterVault, IExchangeCounterView, IPayoutDesk} from "../src/interfaces/Interfaces.sol";
import {MockUSDG, MockExchangeView} from "./mocks/Mocks.sol";

/// The vault on its own, with a stand-in Exchange whose answers the test controls.
contract CounterVaultTest is Test {
    MockUSDG usdg;
    MockExchangeView ex;
    PayoutDesk desk;
    CounterVault vault;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdg = new MockUSDG();
        ex = new MockExchangeView();
        desk = new PayoutDesk(owner);
        vault = CounterVault(
            address(new ERC1967Proxy(address(new CounterVault()), abi.encodeCall(CounterVault.initialize, (IERC20(address(usdg)), owner))))
        );
        vm.startPrank(owner);
        vault.link(IExchangeCounterView(address(ex)), IPayoutDesk(address(desk)));
        desk.link(address(ex), ICounterVault(address(vault)));
        vm.stopPrank();
        usdg.mint(alice, 1_000_000e6);
        usdg.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usdg.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.requestDeposit(amount);
        ex.bump();
        vault.settle(10);
    }

    // ------------------------------------------------------------------ two-step settlement

    function test_depositIsEscrowedUntilTheNextMark() public {
        vm.prank(alice);
        uint256 id = vault.requestDeposit(10_000e6);
        assertEq(vault.navUsdg(), 0, "escrow does not count toward NAV");
        assertEq(vault.balanceOf(alice), 0);

        vault.settle(10); // no new mark yet
        assertEq(vault.balanceOf(alice), 0, "same mark: nothing settles");
        (, , bool done,,,,,) = vault.requests(id);
        assertFalse(done);

        ex.bump();
        vault.settle(10);
        assertGt(vault.balanceOf(alice), 0);
        assertEq(vault.navUsdg(), 10_000e6);
    }

    function test_firstDepositorGetsAboutOneShareUnitPerThousandthOfAUsdgUnit() public {
        _deposit(alice, 1_000e6);
        // 1 USDG = 1e6 units mints 1e9 share-units (9 decimals), so 1,000 USDG mints 1,000e9.
        assertEq(vault.balanceOf(alice), 1_000e9);
    }

    function test_laterDepositorPaysTheCurrentPrice() public {
        _deposit(alice, 10_000e6);
        deal(address(usdg), address(vault), usdg.balanceOf(address(vault)) + 10_000e6); // trading profit doubles NAV
        _deposit(bob, 10_000e6);
        assertApproxEqRel(vault.balanceOf(bob) * 2, vault.balanceOf(alice), 0.001e18, "half as many shares for the same money");
    }

    function test_depositUsesTheWorseOfTheRequestAndSettlePrices() public {
        _deposit(alice, 10_000e6);
        vm.prank(bob);
        vault.requestDeposit(10_000e6);
        uint256 sharesAtRequest = 10_000e9; // price when bob asked
        deal(address(usdg), address(vault), usdg.balanceOf(address(vault)) + 10_000e6); // NAV doubles before settle
        ex.bump();
        vault.settle(10);
        assertLt(vault.balanceOf(bob), sharesAtRequest, "the higher settle-time price applies");
    }

    function test_withdrawUsesTheWorseOfTheRequestAndSettlePrices() public {
        _deposit(alice, 10_000e6);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(shares);
        deal(address(usdg), address(vault), usdg.balanceOf(address(vault)) + 5_000e6); // NAV rises after the request
        ex.bump();
        vault.settle(10);
        // The lower request-time price applies, so the withdrawer does not capture the post-request gain.
        assertApproxEqAbs(usdg.balanceOf(alice), 1_000_000e6 - 10_000e6 + 10_000e6, 1e6);
    }

    function test_traderProfitLowersNavAndLossRaisesIt() public {
        _deposit(alice, 10_000e6);
        ex.setPnl(2_000e6); // traders are up $2,000
        assertEq(vault.navUsdg(), 8_000e6);
        ex.setPnl(-500e6);
        assertEq(vault.navUsdg(), 10_500e6);
        ex.setPnl(50_000e6); // more than the pool holds: NAV floors at zero, never negative
        assertEq(vault.navUsdg(), 0);
    }

    // ------------------------------------------------------------------ withdrawals

    function test_withdrawalIsFilledInFullWhenThereIsCash() public {
        _deposit(alice, 10_000e6);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(shares);
        ex.bump();
        vault.settle(10);
        assertEq(vault.balanceOf(alice), 0);
        assertApproxEqAbs(usdg.balanceOf(alice), 1_000_000e6, 1e6);
    }

    function test_withdrawalsAreFilledProRataWhenCashIsShort() public {
        _deposit(alice, 10_000e6);
        _deposit(bob, 10_000e6);
        ex.setReserve(15_000e6); // $15,000 tied up backing positions, so only $5,000 is free
        uint256 a = vault.balanceOf(alice);
        uint256 b = vault.balanceOf(bob);
        vm.prank(alice);
        uint256 ida = vault.requestWithdraw(a);
        vm.prank(bob);
        vault.requestWithdraw(b);
        ex.bump();
        vault.settle(10);

        // Both asked for the same amount, so both are filled in the same proportion: $2,500 each.
        assertApproxEqAbs(usdg.balanceOf(alice), 1_000_000e6 - 10_000e6 + 2_500e6, 2e6);
        assertApproxEqAbs(usdg.balanceOf(bob), 1_000_000e6 - 10_000e6 + 2_500e6, 2e6);
        (, , bool done,,,,,) = vault.requests(ida);
        assertFalse(done, "the rest of the request stays pending, never cancelled");
    }

    function test_theRestOfAPartialFillIsPaidWhenCashFreesUp() public {
        _deposit(alice, 10_000e6);
        ex.setReserve(8_000e6);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(shares);
        ex.bump();
        vault.settle(10);
        uint256 afterFirst = usdg.balanceOf(alice);
        assertApproxEqAbs(afterFirst, 1_000_000e6 - 10_000e6 + 2_000e6, 2e6);

        ex.setReserve(0);
        ex.bump();
        vault.settle(10);
        assertApproxEqAbs(usdg.balanceOf(alice), 1_000_000e6, 2e6, "fully paid out in the end");
    }

    function test_withdrawalsCannotBePaused() public {
        _deposit(alice, 10_000e6);
        vm.prank(owner);
        vault.setDepositsPaused(true);
        vm.prank(bob);
        vm.expectRevert(CounterVault.DepositsAreFrozen.selector);
        vault.requestDeposit(1e6);

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(aliceShares); // still works
    }

    function test_theDeleverageFlagTripsAfterSeventyTwoHours() public {
        _deposit(alice, 10_000e6);
        ex.setReserve(10_000e6); // nothing free, so the withdrawal cannot be paid
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(aliceShares);
        assertFalse(vault.deleveraging());
        skip(72 hours);
        assertFalse(vault.deleveraging(), "exactly at the limit is still fine");
        skip(1);
        assertTrue(vault.deleveraging());

        ex.setReserve(0);
        ex.bump();
        vault.settle(10);
        assertFalse(vault.deleveraging(), "clears once the queue is paid");
    }

    // ------------------------------------------------------------------ safety

    function test_firstDepositorInflationAttackFails() public {
        // Attacker deposits 1 unit then donates a large amount to inflate the share price.
        usdg.mint(bob, 100_000e6);
        vm.prank(bob);
        vault.requestDeposit(1);
        ex.bump();
        vault.settle(10);
        vm.prank(bob);
        usdg.transfer(address(vault), 50_000e6); // donation

        _deposit(alice, 50_000e6);
        // Without the virtual shares alice would get 0 or 1 share-unit. She must get nearly her fair share.
        assertGt(vault.balanceOf(alice), 0);
        uint256 aliceValue = vault.balanceOf(alice) * vault.navUsdg() / vault.totalSupply();
        assertGt(aliceValue, 49_000e6, "alice keeps almost everything she put in");
    }

    function test_onlyTheExchangeAndTheDeskCanPayOut() public {
        _deposit(alice, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(CounterVault.NotAuthorized.selector);
        vault.payOut(alice, 1e6);

        vm.prank(address(ex));
        vault.payOut(bob, 1e6);
        assertEq(usdg.balanceOf(bob), 1_000_000e6 + 1e6);
    }

    function test_payOutCannotTouchEscrowedDeposits() public {
        vm.prank(alice);
        vault.requestDeposit(10_000e6); // sits in escrow, not in cash
        vm.prank(address(ex));
        vm.expectRevert(CounterVault.InsufficientCash.selector);
        vault.payOut(bob, 1e6);
    }

    function test_outstandingClaimsAreNotWithdrawableByLps() public {
        _deposit(alice, 10_000e6);
        vm.prank(address(ex));
        desk.defer(bob, 4_000e6); // a trader profit paid late: the Counter owes it
        assertEq(vault.navUsdg(), 6_000e6, "the IOU comes off NAV");
        assertEq(vault.freeCash(), 6_000e6, "and off the cash LPs may withdraw");
    }

    function test_cannotBeLinkedTwice() public {
        vm.prank(owner);
        vm.expectRevert(CounterVault.AlreadyLinked.selector);
        vault.link(IExchangeCounterView(address(ex)), IPayoutDesk(address(desk)));
    }

    function test_upgradeNeedsAnnouncementAndFortyEightHours() public {
        address newImpl = address(new CounterVault());
        vm.prank(owner);
        vm.expectRevert(); // not scheduled
        vault.upgradeToAndCall(newImpl, "");

        vm.prank(owner);
        vault.scheduleUpgrade(newImpl);
        vm.prank(owner);
        vm.expectRevert(DelayedUpgrade.UpgradeTooEarly.selector);
        vault.upgradeToAndCall(newImpl, "");

        skip(48 hours);
        vm.prank(owner);
        vault.upgradeToAndCall(newImpl, "");
    }
}
