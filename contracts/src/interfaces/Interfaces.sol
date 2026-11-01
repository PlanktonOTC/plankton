// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IMarkOracle {
    enum Status {
        Unset,
        Open,
        Extended,
        Weekend,
        Frozen,
        Halted
    }

    struct OracleConfig {
        address chainlinkFeed; // zero for a market Chainlink does not cover: every mark then needs a quorum
        uint16 bandBps; // max |signed - Chainlink| in Open/Extended before a quorum is needed
        uint16 jumpBps; // move vs the last mark that sets the breaker
        uint32 maxAgeSec; // attestation age
        uint32 chainlinkMaxAgeSec; // Chainlink freshness (feed heartbeat plus margin)
        uint16 liqAgreementBps; // signed vs Chainlink agreement needed to liquidate
        uint8 reanchorConfirmations; // consistent marks that clear the breaker
        uint8 quorumOutsideBand; // signers needed for an out-of-band mark
        uint16 heldBandBps; // Weekend/Frozen/Halted: max |signed - held reference| before a quorum is needed
    }

    struct Attestation {
        bytes32 marketId;
        uint256 markE18;
        uint256 refCloseE18;
        uint16 confidenceBps;
        Status status;
        uint64 sequence;
        uint64 observedAt;
        uint64 expiry;
    }

    struct Mark {
        uint256 priceE18;
        uint16 confidenceBps;
        Status status;
        uint64 sequence;
        uint64 updatedAt; // when the underlying data was observed, not when it was published
        bool breaker;
    }

    function publish(Attestation calldata a, bytes[] calldata sigs) external;
    function markOf(bytes32 marketId) external view returns (Mark memory);
    function configOf(bytes32 marketId) external view returns (OracleConfig memory);
    /// Chainlink answer already in Stock Token terms (multiplier embedded). Never multiply again.
    function chainlinkPrice(bytes32 marketId) external view returns (uint256 priceE18, uint64 updatedAt);

    event MarkPublished(
        bytes32 indexed marketId, uint256 priceE18, Status status, uint64 sequence, uint16 confidenceBps, bool breaker
    );
    event BreakerSet(bytes32 indexed marketId, uint256 priorE18, uint256 newE18);
    event Reanchored(bytes32 indexed marketId, uint256 priceE18);
    event ConfigScheduled(bytes32 indexed marketId, OracleConfig config, uint64 effectiveAt);
    event SignerChanged(address indexed signer, bool allowed, uint64 effectiveAt);

    /// Held references, set only by Chainlink-bounded (Open/Extended) marks. A single signer can never move them.
    /// regularClose: the last Open mark (Friday's close over the weekend). lastBounded: the last Open or Extended mark.
    /// openSince: when the market last entered Open from another status (start of the open guard).
    function referencesOf(bytes32 marketId)
        external
        view
        returns (uint256 regularCloseE18, uint256 lastBoundedE18, uint64 openSince);
}

interface ICounterVault {
    function navUsdg() external view returns (uint256);
    /// USDG held by the vault that is not escrowed deposits.
    function cashUsdg() external view returns (uint256);
    function payOut(address to, uint256 amount) external;
    /// True when a withdrawal has waited past the hard maximum: opens stop until the queue clears.
    function deleveraging() external view returns (bool);
}

/// What the vault needs to know about trader positions.
interface IExchangeCounterView {
    function markEpoch() external view returns (uint256);
    function traderUnrealizedPnlUsdg() external view returns (int256);
    function counterReserveUsdg() external view returns (uint256);
    /// False while any market with open interest has no mark, a set breaker or a stale mark: the vault does not settle on it.
    function navPricesFresh() external view returns (bool);
}

interface IPayoutDesk {
    function defer(address trader, uint256 amountUsdg) external returns (uint64 claimableAt);
    function outstanding() external view returns (uint256);
}

interface IBackstopFund {
    function cover(bytes32 marketId, uint256 amountUsdg) external returns (uint256 covered);
    function targetUsdg() external view returns (uint256);
}

interface IFirstLossTranche {
    function absorb(uint256 amountUsdg) external returns (uint256 absorbed);
}

interface IFeeRouter {
    function route(uint256 feeUsdg, address referrer) external;
}
