// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MarkOracle} from "../src/MarkOracle.sol";
import {CounterVault} from "../src/CounterVault.sol";
import {Exchange} from "../src/Exchange.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {PayoutDesk} from "../src/PayoutDesk.sol";
import {BackstopFund, FirstLossTranche} from "../src/Reserves.sol";
import {
    IBackstopFund,
    ICounterVault,
    IFirstLossTranche,
    IFeeRouter,
    IMarkOracle,
    IPayoutDesk
} from "../src/interfaces/Interfaces.sol";
import {MarketConfig, MarketState, Position, SessionProfile} from "../src/ExchangeTypes.sol";
import {ExchangeMath as M} from "../src/ExchangeMath.sol";
import {MockUSDG, MockFeed} from "./mocks/Mocks.sol";

/// Deploys the whole system on a clean local chain: one market ($100 token), a $100,000 Counter, one trader.
abstract contract Base is Test {
    uint256 internal constant PK_MARK1 = 0xA11CE;
    uint256 internal constant PK_MARK2 = 0xB0B;
    uint256 internal constant PK_QUOTE = 0xC0FFEE;
    uint256 internal constant PK_TRADER = 0x7EAD;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");
    address internal keeper = makeAddr("keeper");
    address internal trader;

    MockUSDG internal usdg;
    MockFeed internal feed;
    MarkOracle internal oracle;
    CounterVault internal vault;
    Exchange internal exchange;
    BackstopFund internal backstop;
    FirstLossTranche internal firstLoss;
    PayoutDesk internal desk;
    FeeRouter internal router;

    bytes32 internal constant ID = keccak256(abi.encode("plankton.mkt.v1", "TEST", address(0xBEEF)));
    uint256 internal constant PRICE = 100e18;
    uint64 internal seq;
    /// Market the helpers below act on. Tests with a second market point it there.
    bytes32 internal mkt = ID;
    uint64 internal nonce;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "TradeQuote(bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 execPriceE18,uint256 feeUsdg,uint64 maxLeverageE18,uint64 markSequence,uint64 nonce,uint64 expiry)"
    );

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        trader = vm.addr(PK_TRADER);
        usdg = new MockUSDG();
        feed = new MockFeed();

        address[] memory markSigners = new address[](2);
        markSigners[0] = vm.addr(PK_MARK1);
        markSigners[1] = vm.addr(PK_MARK2);
        oracle = new MarkOracle(owner, markSigners);

        vault = CounterVault(
            address(
                new ERC1967Proxy(
                    address(new CounterVault()), abi.encodeCall(CounterVault.initialize, (IERC20(address(usdg)), owner))
                )
            )
        );
        backstop = new BackstopFund(IERC20(address(usdg)), owner);
        firstLoss = new FirstLossTranche(IERC20(address(usdg)), owner);
        desk = new PayoutDesk(owner);
        router = new FeeRouter(
            IERC20(address(usdg)),
            ICounterVault(address(vault)),
            IBackstopFund(address(backstop)),
            address(firstLoss),
            treasury,
            FeeRouter.Split({counterBps: 7_500, backstopBps: 2_000, juniorBps: 0, treasuryBps: 500}),
            owner
        );

        address[] memory quoteSigners = new address[](1);
        quoteSigners[0] = vm.addr(PK_QUOTE);
        Exchange.Deps memory deps = Exchange.Deps({
            usdg: IERC20(address(usdg)),
            oracle: IMarkOracle(address(oracle)),
            vault: ICounterVault(address(vault)),
            backstop: IBackstopFund(address(backstop)),
            firstLoss: IFirstLossTranche(address(firstLoss)),
            feeRouter: IFeeRouter(address(router)),
            payoutDesk: IPayoutDesk(address(desk))
        });
        exchange = Exchange(
            address(
                new ERC1967Proxy(
                    address(new Exchange()), abi.encodeCall(Exchange.initialize, (owner, deps, quoteSigners))
                )
            )
        );

        vm.startPrank(owner);
        backstop.link(address(exchange), ICounterVault(address(vault)));
        firstLoss.link(address(exchange), ICounterVault(address(vault)));
        desk.link(address(exchange), ICounterVault(address(vault)));
        vault.link(exchange, IPayoutDesk(address(desk)));
        desk.setGuardian(guardian);
        exchange.setGuardian(guardian);
        oracle.scheduleConfig(ID, oracleConfig());
        exchange.scheduleMarket(ID, marketConfig());
        vm.stopPrank();

        skip(24 hours + 1);
        exchange.applyMarket(ID);

        // Counter funded with $100,000 through the real two-step flow.
        setPrice(PRICE);
        usdg.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdg.approve(address(vault), type(uint256).max);
        vault.requestDeposit(100_000e6);
        vm.stopPrank();
        skip(5);
        setPrice(PRICE);
        vault.settle(10);

        usdg.mint(trader, 1_000_000e6);
        vm.prank(trader);
        usdg.approve(address(exchange), type(uint256).max);
    }

    // ------------------------------------------------------------------ settings (override to change a test's market)

    function oracleConfig() internal view virtual returns (IMarkOracle.OracleConfig memory) {
        return IMarkOracle.OracleConfig({
            chainlinkFeed: address(feed),
            bandBps: 150,
            jumpBps: 2_000,
            maxAgeSec: 180,
            chainlinkMaxAgeSec: 90_000,
            liqAgreementBps: 100,
            reanchorConfirmations: 3,
            quorumOutsideBand: 2,
            heldBandBps: 100
        });
    }

    function marketConfig() internal pure virtual returns (MarketConfig memory c) {
        c.state = MarketState.Active;
        c.maintenanceMarginBps = 500;
        c.maxExecDeviationBps = 500;
        c.maxConfidenceBps = 200;
        c.maxMarkAgeSec = 180;
        c.netSkewBpsOfV = 400;
        c.grossOiBpsOfV = 1_200;
        c.positionBpsOfV = 100;
        c.absOiCapUsdg = 0;
        c.skewScaleE18 = uint256(4_000e6) * 1e12 * 10_000 / 150; // net-skew cap ($4,000) -> ~0.75% impact at the cap
        c.feeBps = 8;
        c.borrowBaseBpsPerHour = 2;
        c.minHoldSec = 60;
        c.fallbackSpreadBps = 100;
        c.frozenSpreadBps = 200;
        c.profiles[1] = SessionProfile(true, false, 0, 100, 3e18); // Open
        c.profiles[2] = SessionProfile(true, false, 50, 50, 2.5e18); // Extended
        c.profiles[3] = SessionProfile(true, true, 150, 25, 2e18); // Weekend
        c.profiles[4] = SessionProfile(false, false, 200, 0, 0); // Frozen
        c.profiles[5] = SessionProfile(false, false, 300, 0, 0); // Halted
    }

    // ------------------------------------------------------------------ oracle helpers

    function attest(uint256 price, IMarkOracle.Status st, uint16 conf)
        internal
        returns (IMarkOracle.Attestation memory)
    {
        return IMarkOracle.Attestation(
            mkt, price, price, conf, st, ++seq, uint64(block.timestamp), uint64(block.timestamp + 120)
        );
    }

    function sign(uint256 pk, IMarkOracle.Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    /// Signatures ordered by ascending signer address, as the oracle requires.
    function sigs(IMarkOracle.Attestation memory a, bool both) internal view returns (bytes[] memory out) {
        bytes memory s1 = sign(PK_MARK1, a);
        if (!both) {
            out = new bytes[](1);
            out[0] = s1;
            return out;
        }
        bytes memory s2 = sign(PK_MARK2, a);
        out = new bytes[](2);
        bool oneFirst = vm.addr(PK_MARK1) < vm.addr(PK_MARK2);
        out[0] = oneFirst ? s1 : s2;
        out[1] = oneFirst ? s2 : s1;
    }

    function publish(uint256 price, IMarkOracle.Status st, uint16 conf, bool both) internal {
        IMarkOracle.Attestation memory a = attest(price, st, conf);
        oracle.publish(a, sigs(a, both));
    }

    /// Moves Chainlink and the signed mark together, the normal case: one signer is enough.
    function setPrice(uint256 price) internal {
        feed.set(int256(price / 1e10), block.timestamp);
        publish(price, IMarkOracle.Status.Open, 10, false);
    }

    /// A gap: Chainlink and the mark move together by more than the jump limit, with a quorum so the breaker does not stay set.
    function gapTo(uint256 price) internal {
        feed.set(int256(price / 1e10), block.timestamp);
        publish(price, IMarkOracle.Status.Open, 10, true);
    }

    function pos(address who) internal view returns (Position memory) {
        return exchange.positionOf(who, mkt);
    }

    function cash() internal view returns (uint256) {
        return vault.cashUsdg();
    }

    function nextBlock() internal {
        vm.roll(block.number + 1);
        skip(2);
    }

    // ------------------------------------------------------------------ quote helpers

    function skewScale() internal pure returns (uint256) {
        return marketConfig().skewScaleE18;
    }

    /// Spread the contract charges this trade on top of the skew price: the session's (and open guard's) for opens,
    /// the frozen spread for closes in a frozen, halted or close-only market.
    function requiredSpread(address who, int256 size) internal view returns (uint256) {
        IMarkOracle.Mark memory mk = oracle.markOf(mkt);
        MarketConfig memory c = exchange.configOf(mkt);
        int256 cur = exchange.positionOf(who, mkt).size;
        if (M.isReducing(cur, size)) {
            bool frozen = mk.status == IMarkOracle.Status.Frozen || mk.status == IMarkOracle.Status.Halted
                || c.state != MarketState.Active;
            return frozen ? c.frozenSpreadBps : 0;
        }
        uint256 spread = c.profiles[uint8(mk.status)].extraSpreadBps;
        (,, uint64 since) = oracle.referencesOf(mkt);
        if (
            mk.status == IMarkOracle.Status.Open && c.openGuardSec != 0
                && block.timestamp < uint256(since) + c.openGuardSec
        ) {
            spread += c.openGuardSpreadBps;
        }
        return spread;
    }

    /// A quote at exactly the minimum price the contract accepts for the trader: skew-impact price, plus the spread the
    /// contract requires, plus `spreadBps` more.
    function quoteFor(address who, int256 size, uint256 spreadBps) internal returns (Exchange.TradeQuote memory q) {
        spreadBps += requiredSpread(who, size);
        IMarkOracle.Mark memory mk = oracle.markOf(mkt);
        (uint128 l, uint128 sh,,,) = exchange.marketInfo(mkt);
        int256 before_ = (int256(uint256(l)) - int256(uint256(sh))) * 1e12;
        int256 tradeE18 = int256(M.notional(M.abs(size), mk.priceE18) * 1e12) * (size > 0 ? int256(1) : int256(-1));
        uint256 fill = M.skewFill(mk.priceE18, before_, before_ + tradeE18, skewScale());
        uint256 exec = size > 0 ? fill * (10_000 + spreadBps) / 10_000 : fill * (10_000 - spreadBps) / 10_000;
        uint64 lev = uint64(exchange.configOf(mkt).profiles[uint8(mk.status)].maxLeverageE18);
        q = Exchange.TradeQuote({
            marketId: mkt,
            trader: who,
            sizeDeltaE18: size,
            execPriceE18: exec,
            feeUsdg: M.notional(M.abs(size), exec) * 8 / 10_000,
            maxLeverageE18: lev == 0 ? 3e18 : lev,
            markSequence: mk.sequence,
            nonce: ++nonce,
            expiry: uint64(block.timestamp + 60)
        });
    }

    function quoteSig(Exchange.TradeQuote memory q) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.marketId,
                q.trader,
                q.sizeDeltaE18,
                q.execPriceE18,
                q.feeUsdg,
                q.maxLeverageE18,
                q.markSequence,
                q.nonce,
                q.expiry
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_QUOTE, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// Opens a position for `who`: signed quote, deposit, execute. Size in tokens (E18), margin in USDG.
    function open(address who, int256 size, uint128 margin) internal returns (Exchange.TradeQuote memory q) {
        q = quoteFor(who, size, 0);
        bytes memory sig = quoteSig(q);
        usdg.mint(who, margin + q.feeUsdg);
        vm.startPrank(who);
        usdg.approve(address(exchange), type(uint256).max);
        exchange.deposit(margin + q.feeUsdg);
        exchange.execute(q, sig, margin);
        vm.stopPrank();
    }

    /// Reduces `who`'s position by `bps`, with a quote signed for the current mark.
    function reduce(address who, uint16 bps) internal returns (Exchange.TradeQuote memory q) {
        nextBlock();
        int256 size = exchange.positionOf(who, mkt).size;
        int256 delta = M.fractionClose(size, bps);
        q = quoteFor(who, delta, 0);
        bytes memory sig = quoteSig(q);
        vm.prank(who);
        exchange.execute(q, sig, 0);
    }
}
