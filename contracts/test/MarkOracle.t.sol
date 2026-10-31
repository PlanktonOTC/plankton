// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {IMarkOracle} from "../src/interfaces/Interfaces.sol";

contract MarkOracleTest is Base {
    // ------------------------------------------------------------------ the Chainlink band

    function test_inBandMarkNeedsOneSigner() public {
        feed.set(int256(100e8), block.timestamp);
        publish(100.5e18, IMarkOracle.Status.Open, 10, false); // 0.5% from Chainlink, inside the 1.5% band
        assertEq(oracle.markOf(ID).priceE18, 100.5e18);
    }

    function test_outOfBandMarkNeedsAQuorum() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(103e18, IMarkOracle.Status.Open, 10); // 3% away
        bytes[] memory sg1 = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, sg1);

        a = attest(103e18, IMarkOracle.Status.Open, 10);
        oracle.publish(a, sigs(a, true)); // two signers: accepted
        assertEq(oracle.markOf(ID).priceE18, 103e18);
    }

    function test_staleChainlinkNeedsAQuorumInOpenSession() public {
        feed.set(int256(100e8), block.timestamp - 100_000); // older than chainlinkMaxAgeSec (90,000)
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        bytes[] memory sg2 = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, sg2);
    }

    // ------------------------------------------------------------------ signatures and freshness

    function test_unknownSignerIsRejected() public {
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, oracle.hashAttestation(a));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encodePacked(r, s, v);
        vm.expectRevert(MarkOracle.BadSignature.selector);
        oracle.publish(a, bad);
    }

    function test_duplicateSignerIsRejected() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(103e18, IMarkOracle.Status.Open, 10);
        bytes[] memory dup = new bytes[](2);
        dup[0] = sign(PK_MARK1, a);
        dup[1] = sign(PK_MARK1, a); // the same key twice must not count as a quorum
        vm.expectRevert(MarkOracle.BadSignature.selector);
        oracle.publish(a, dup);
    }

    function test_signaturesMustBeOrderedBySigner() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(103e18, IMarkOracle.Status.Open, 10);
        bytes[] memory ok = sigs(a, true);
        bytes[] memory swapped = new bytes[](2);
        swapped[0] = ok[1];
        swapped[1] = ok[0];
        vm.expectRevert(MarkOracle.BadSignature.selector);
        oracle.publish(a, swapped);
    }

    function test_sequenceMustIncrease() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        oracle.publish(a, sigs(a, false));
        bytes[] memory sg3 = sigs(a, false);
        vm.expectRevert(MarkOracle.StaleSequence.selector);
        oracle.publish(a, sg3); // replay of the same attestation
    }

    function test_expiredAttestationIsRejected() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        skip(121);
        feed.set(int256(100e8), block.timestamp);
        bytes[] memory sg4 = sigs(a, false);
        vm.expectRevert(MarkOracle.Expired.selector);
        oracle.publish(a, sg4);
    }

    function test_oldObservationIsRejected() public {
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        a.observedAt = uint64(block.timestamp - 181); // older than maxAgeSec
        bytes[] memory sg5 = sigs(a, false);
        vm.expectRevert(MarkOracle.TooOld.selector);
        oracle.publish(a, sg5);
    }

    function test_futureObservationIsRejected() public {
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        a.observedAt = uint64(block.timestamp + 60);
        bytes[] memory sg6 = sigs(a, false);
        vm.expectRevert(MarkOracle.FutureObservation.selector);
        oracle.publish(a, sg6);
    }

    // ------------------------------------------------------------------ the jump breaker

    function test_jumpSetsTheBreakerAndThreeConsistentMarksClearIt() public {
        setPrice(100e18);
        // Chainlink and the mark both gap by 30%, signed by one signer only: a jump beyond jumpBps (20%).
        feed.set(int256(70e8), block.timestamp);
        publish(70e18, IMarkOracle.Status.Open, 10, false);
        assertTrue(oracle.markOf(ID).breaker, "breaker set");

        publish(70e18, IMarkOracle.Status.Open, 10, false);
        publish(70.2e18, IMarkOracle.Status.Open, 10, false);
        assertTrue(oracle.markOf(ID).breaker, "two consistent marks are not enough");
        publish(70.1e18, IMarkOracle.Status.Open, 10, false);
        assertFalse(oracle.markOf(ID).breaker, "three consistent marks re-anchor");
    }

    function test_aQuorumReanchorsAtOnce() public {
        setPrice(100e18);
        feed.set(int256(70e8), block.timestamp);
        publish(70e18, IMarkOracle.Status.Open, 10, false);
        assertTrue(oracle.markOf(ID).breaker);
        feed.set(int256(45e8), block.timestamp);
        publish(45e18, IMarkOracle.Status.Open, 10, true); // another gap, but two signers agree
        assertFalse(oracle.markOf(ID).breaker);
    }

    function test_aQuorumJumpDoesNotSetTheBreaker() public {
        setPrice(100e18);
        gapTo(60e18);
        assertFalse(oracle.markOf(ID).breaker);
        assertEq(oracle.markOf(ID).priceE18, 60e18);
    }

    // ------------------------------------------------------------------ sessions without Chainlink

    function test_weekendMarkMustStayNearTheLastMark() public {
        setPrice(100e18);
        IMarkOracle.Attestation memory a = attest(130e18, IMarkOracle.Status.Weekend, 25); // +30%, no Chainlink bound
        bytes[] memory sg7 = sigs(a, false);
        vm.expectRevert(abi.encodeWithSelector(MarkOracle.QuorumRequired.selector, 1, 2));
        oracle.publish(a, sg7);

        a = attest(100.2e18, IMarkOracle.Status.Weekend, 25);
        oracle.publish(a, sigs(a, false));
        assertEq(uint8(oracle.markOf(ID).status), uint8(IMarkOracle.Status.Weekend));
    }

    function test_unknownMarketAndZeroPriceAreRejected() public {
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        a.marketId = keccak256("nope");
        bytes[] memory sg8 = sigs(a, false);
        vm.expectRevert(MarkOracle.NotConfigured.selector);
        oracle.publish(a, sg8);

        a = attest(0, IMarkOracle.Status.Open, 10);
        bytes[] memory sg9 = sigs(a, false);
        vm.expectRevert(MarkOracle.BadAttestation.selector);
        oracle.publish(a, sg9);
    }

    // ------------------------------------------------------------------ owner powers and delays

    function test_looseningTheConfigWaitsTwentyFourHours() public {
        IMarkOracle.OracleConfig memory c = oracle.configOf(ID);
        c.bandBps = 400;
        vm.prank(owner);
        oracle.scheduleConfig(ID, c);
        assertEq(oracle.configOf(ID).bandBps, 150, "still the old band");

        vm.expectRevert(MarkOracle.TooEarly.selector);
        oracle.applyConfig(ID);
        skip(24 hours);
        oracle.applyConfig(ID);
        assertEq(oracle.configOf(ID).bandBps, 400);
    }

    function test_tighteningTheConfigAppliesAtOnceAndCancelsAPendingLoosening() public {
        IMarkOracle.OracleConfig memory loose = oracle.configOf(ID);
        loose.bandBps = 400;
        vm.prank(owner);
        oracle.scheduleConfig(ID, loose);

        IMarkOracle.OracleConfig memory tight = oracle.configOf(ID);
        tight.bandBps = 100;
        vm.prank(owner);
        oracle.scheduleConfig(ID, tight);
        assertEq(oracle.configOf(ID).bandBps, 100);

        skip(24 hours);
        vm.expectRevert(MarkOracle.NothingPending.selector);
        oracle.applyConfig(ID);
    }

    function test_onlyTheOwnerCanChangeConfigOrSigners() public {
        IMarkOracle.OracleConfig memory c = oracle.configOf(ID);
        vm.expectRevert();
        oracle.scheduleConfig(ID, c);
        vm.expectRevert();
        oracle.setSigner(address(0x1234), true);
    }

    function test_removingASignerIsInstantButAddingOneWaitsTwentyFourHours() public {
        address stranger = address(0x1234);
        vm.prank(owner);
        oracle.setSigner(stranger, true);
        assertFalse(oracle.isSigner(stranger));
        vm.expectRevert(MarkOracle.TooEarly.selector);
        oracle.applySigner(stranger);
        skip(24 hours);
        oracle.applySigner(stranger);
        assertTrue(oracle.isSigner(stranger));

        vm.prank(owner);
        oracle.setSigner(stranger, false);
        assertFalse(oracle.isSigner(stranger), "removal is instant");
    }

    function test_atMostThreeSigners() public {
        address s3 = address(0x3333);
        address s4 = address(0x4444);
        vm.startPrank(owner);
        oracle.setSigner(s3, true);
        oracle.setSigner(s4, true);
        vm.stopPrank();
        skip(24 hours);
        oracle.applySigner(s3);
        vm.expectRevert(MarkOracle.SignerLimit.selector);
        oracle.applySigner(s4);
    }

    function test_aRemovedSignerCanNoLongerSign() public {
        vm.prank(owner);
        oracle.setSigner(vm.addr(PK_MARK1), false);
        feed.set(int256(100e8), block.timestamp);
        IMarkOracle.Attestation memory a = attest(100e18, IMarkOracle.Status.Open, 10);
        bytes[] memory sg10 = sigs(a, false);
        vm.expectRevert(MarkOracle.BadSignature.selector);
        oracle.publish(a, sg10);
    }

    function test_chainlinkPriceIsReadInStockTokenTermsWithoutAnyMultiplier() public {
        feed.set(int256(123.45e8), block.timestamp);
        (uint256 px, uint64 at) = oracle.chainlinkPrice(ID);
        assertEq(px, 123.45e18);
        assertEq(at, block.timestamp);
    }
}
