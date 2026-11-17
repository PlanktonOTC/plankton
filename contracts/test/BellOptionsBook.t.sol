// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MockUSDG} from "./mocks/Mocks.sol";
import {BellOptionsBook} from "../src/BellOptionsBook.sol";
import {BellSettlementOracle} from "../src/BellSettlementOracle.sol";
import {IMarkOracle, ICounterVault, IExchangeMarketRisk} from "../src/interfaces/Interfaces.sol";

contract BellBookCounterMock {
    MockUSDG public immutable usdg;
    uint256 public navUsdg = 100_000e6;
    uint256 public reserve;

    constructor(MockUSDG token) { usdg = token; }
    function reserveOptionPayout(uint256 amount) external {
        require(usdg.balanceOf(address(this)) >= reserve + amount, "underfunded");
        reserve += amount;
    }
    function settleOptionPayout(uint256 reserved, uint256 liability) external {
        require(reserve >= reserved && liability <= reserved, "bad reserve");
        reserve -= reserved - liability;
    }
    function payOptionPayout(address to, uint256 amount) external {
        require(amount <= reserve, "bad claim");
        reserve -= amount;
        usdg.transfer(to, amount);
    }
}

contract BellBookMarkMock {
    IMarkOracle.Mark private _mark;
    function setMark(IMarkOracle.Mark calldata mark_) external { _mark = mark_; }
    function markOf(bytes32) external view returns (IMarkOracle.Mark memory) { return _mark; }
}

contract BellBookExchangeMock {
    function marketInfo(bytes32) external pure returns (uint128, uint128, uint128, uint128, uint128) {
        return (0, 0, 0, 0, 0);
    }
}

contract BellOptionsBookTest is Test {
    bytes32 private constant REF_TYPEHASH = keccak256(
        "SeriesReference(bytes32 marketId,uint64 expiry,uint256 sourcePriceA,uint256 sourcePriceB,bytes32 sourceIdA,bytes32 sourceIdB,uint64 observedAtA,uint64 observedAtB,uint64 nonce)"
    );
    bytes32 private constant SETTLE_TYPEHASH = keccak256(
        "Settlement(bytes32 marketId,uint64 expiry,uint256 closingPriceE18,uint256 markA,uint256 markB,uint256 markC,uint256 twap30mE18,uint64 marksObservedAt,uint64 closeObservedAt,uint64 twapStart,uint64 twapEnd,bool halted,uint256 fallbackMarkE18,uint64 fallbackObservedAt,uint64 nonce)"
    );
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "BellQuote(address trader,bytes32 marketId,uint64 expiry,uint256 strikeE18,uint8 optionType,uint256 payoutUsdg,uint256 premiumUsdg,uint64 markSequence,uint64 validUntil,uint256 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    uint256[3] private signerKeys = [uint256(101), uint256(202), uint256(303)];
    uint256 private quoteKey = 404;
    address[3] private settlementSigners;
    uint256 private ownerKey = 505;
    address private owner;
    address private buyer = makeAddr("buyer");
    bytes32 private marketId = keccak256("WYFI");
    MockUSDG private usdg;
    BellBookCounterMock private counter;
    BellBookMarkMock private mark;
    BellBookExchangeMock private exchange;
    BellSettlementOracle private oracle;
    BellOptionsBook private book;
    uint64 private expiry;

    function setUp() public {
        vm.warp(1_800_000_000);
        owner = vm.addr(ownerKey);
        for (uint256 i; i < 3; ++i) settlementSigners[i] = vm.addr(signerKeys[i]);
        _sortSigners();
        usdg = new MockUSDG();
        counter = new BellBookCounterMock(usdg);
        mark = new BellBookMarkMock();
        exchange = new BellBookExchangeMock();
        oracle = new BellSettlementOracle(owner, settlementSigners);
        book = new BellOptionsBook(owner, usdg, ICounterVault(address(counter)), IMarkOracle(address(mark)),
            IExchangeMarketRisk(address(exchange)), oracle, vm.addr(quoteKey));
        expiry = uint64(block.timestamp + 3 days);
        mark.setMark(IMarkOracle.Mark({priceE18: 100e18, confidenceBps: 10, status: IMarkOracle.Status.Open,
            sequence: 7, updatedAt: uint64(block.timestamp), breaker: false}));
        usdg.mint(address(counter), 100_000e6);
        usdg.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usdg.approve(address(book), type(uint256).max);
        _publishReference();
        vm.prank(owner);
        book.setOpensEnabled(true);
    }

    function test_callWinsAndPaysFixedPayout() public {
        uint256 id = _buy();
        assertEq(counter.reserve(), 110e6);
        assertEq(usdg.balanceOf(buyer), 990e6);
        _publishSettlement(120e18);
        book.resolve(id);
        (,,,,,,,, BellOptionsBook.Outcome outcome,) = book.tickets(id);
        assertEq(uint256(outcome), uint256(BellOptionsBook.Outcome.Win));
        vm.prank(buyer);
        book.claim(id);
        assertEq(usdg.balanceOf(buyer), 1_090e6);
        assertEq(counter.reserve(), 0);
    }

    function test_tieRefundsPremium() public {
        uint256 id = _buy();
        _publishSettlement(110e18);
        book.resolve(id);
        vm.prank(buyer);
        book.claim(id);
        assertEq(usdg.balanceOf(buyer), 1_000e6);
        assertEq(counter.reserve(), 0);
    }

    function test_haltedSeriesCanUseDelayedSignedFallback() public {
        uint256 id = _buy();
        uint64 fallbackAt = expiry - 1 hours;
        vm.warp(uint256(expiry) + 10 days);
        BellSettlementOracle.SettlementReport memory r = BellSettlementOracle.SettlementReport({
            marketId: marketId, expiry: expiry, closingPriceE18: 0, markA: 0, markB: 0, markC: 0,
            twap30mE18: 0, marksObservedAt: 0, closeObservedAt: 0, twapStart: 0, twapEnd: 0,
            halted: true, fallbackMarkE18: 120e18, fallbackObservedAt: fallbackAt, nonce: 3
        });
        bytes32 digest = _typedDigest(address(oracle), "Plankton Bell Settlement", abi.encode(
            SETTLE_TYPEHASH, r.marketId, r.expiry, r.closingPriceE18, r.markA, r.markB, r.markC,
            r.twap30mE18, r.marksObservedAt, r.closeObservedAt, r.twapStart, r.twapEnd,
            r.halted, r.fallbackMarkE18, r.fallbackObservedAt, uint64(r.nonce)
        ));
        oracle.publishSettlement(r, _twoSignatures(digest));
        book.resolve(id);
        vm.prank(buyer);
        book.claim(id);
        assertEq(usdg.balanceOf(buyer), 1_090e6);
    }

    function test_walletExposureIsCappedAtTwoPercentOfCounterNav() public {
        vm.expectRevert(BellOptionsBook.RiskLimit.selector);
        _buyAmount(2_001e6, 201e6, 9);
    }

    function test_openDisabledByDefaultAndMarkMustBeFresh() public {
        vm.prank(owner);
        book.setOpensEnabled(false);
        vm.expectRevert(BellOptionsBook.OpensClosed.selector);
        _buy();
        vm.prank(owner);
        book.setOpensEnabled(true);
        mark.setMark(IMarkOracle.Mark({priceE18: 100e18, confidenceBps: 10, status: IMarkOracle.Status.Open,
            sequence: 7, updatedAt: uint64(block.timestamp - 61), breaker: false}));
        vm.expectRevert(BellOptionsBook.StaleMark.selector);
        _buy();
    }

    function _buy() private returns (uint256) {
        return _buyAmount(100e6, 10e6, 1);
    }

    function _buyAmount(uint256 payout, uint256 premium, uint256 nonce) private returns (uint256) {
        BellOptionsBook.Quote memory q = BellOptionsBook.Quote({trader: buyer, marketId: marketId,
            expiry: expiry, strikeE18: 110e18, optionType: BellOptionsBook.OptionType.Call,
            payoutUsdg: payout, premiumUsdg: premium, markSequence: 7,
            validUntil: uint64(block.timestamp + 30), nonce: nonce});
        bytes32 digest = _typedDigest(address(book), "Plankton Bell Options", abi.encode(
            QUOTE_TYPEHASH, q.trader, q.marketId, q.expiry, q.strikeE18, q.optionType,
            q.payoutUsdg, q.premiumUsdg, q.markSequence, q.validUntil, q.nonce
        ));
        bytes memory signature = _sign(quoteKey, digest);
        vm.prank(buyer);
        return book.buy(q, signature);
    }

    function _publishReference() private {
        BellSettlementOracle.ReferenceReport memory r = BellSettlementOracle.ReferenceReport({
            marketId: marketId, expiry: expiry, sourcePriceA: 100e18, sourcePriceB: 100e18,
            sourceIdA: keccak256("source-a"), sourceIdB: keccak256("source-b"),
            observedAtA: uint64(block.timestamp), observedAtB: uint64(block.timestamp), nonce: 1
        });
        bytes32 digest = _typedDigest(address(oracle), "Plankton Bell Settlement", abi.encode(
            REF_TYPEHASH, r.marketId, r.expiry, r.sourcePriceA, r.sourcePriceB, r.sourceIdA, r.sourceIdB,
            r.observedAtA, r.observedAtB, r.nonce
        ));
        oracle.publishReference(r, _twoSignatures(digest));
    }

    function _publishSettlement(uint256 price) private {
        vm.warp(expiry);
        BellSettlementOracle.SettlementReport memory r = BellSettlementOracle.SettlementReport({
            marketId: marketId, expiry: expiry, closingPriceE18: price, markA: price, markB: price,
            markC: price, twap30mE18: price, marksObservedAt: expiry, closeObservedAt: expiry,
            twapStart: expiry - 30 minutes, twapEnd: expiry, halted: false,
            fallbackMarkE18: 0, fallbackObservedAt: 0, nonce: 2
        });
        bytes32 digest = _typedDigest(address(oracle), "Plankton Bell Settlement", abi.encode(
            SETTLE_TYPEHASH, r.marketId, r.expiry, r.closingPriceE18, r.markA, r.markB, r.markC,
            r.twap30mE18, r.marksObservedAt, r.closeObservedAt, r.twapStart, r.twapEnd,
            r.halted, r.fallbackMarkE18, r.fallbackObservedAt, uint64(r.nonce)
        ));
        oracle.publishSettlement(r, _twoSignatures(digest));
    }

    function _typedDigest(address verifying, string memory name, bytes memory structHashData)
        private view returns (bytes32)
    {
        bytes32 structHash = keccak256(structHashData);
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes("1")),
            block.chainid, verifying));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _twoSignatures(bytes32 digest) private returns (bytes[] memory sigs) {
        bytes[3] memory all;
        for (uint256 i; i < 3; ++i) all[i] = _sign(signerKeys[i], digest);
        // Sort recovered addresses, then take the first two.
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (ECDSA.recover(digest, all[i]) > ECDSA.recover(digest, all[j])) {
                    (all[i], all[j]) = (all[j], all[i]);
                }
            }
        }
        sigs = new bytes[](2);
        sigs[0] = all[0];
        sigs[1] = all[1];
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sortSigners() private {
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (settlementSigners[i] > settlementSigners[j]) {
                    (settlementSigners[i], settlementSigners[j]) = (settlementSigners[j], settlementSigners[i]);
                }
            }
        }
    }
}
