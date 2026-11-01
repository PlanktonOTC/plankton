// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IMarkOracle,
    ICounterVault,
    IPayoutDesk,
    IBackstopFund,
    IFirstLossTranche,
    IFeeRouter
} from "./interfaces/Interfaces.sol";

// Shared by Exchange, ExchangeLib and MarketConfigLib. One file so all three see identical storage layouts.

enum MarketState {
    Unset, // Paused = no new entries; reduces always allowed
    Active,
    CloseOnly,
    Paused
}

struct SessionProfile {
    bool opensAllowed;
    bool perWallet; // the position limit applies across all of a wallet's markets
    uint16 extraSpreadBps;
    uint16 maxPositionBpsOfV;
    uint64 maxLeverageE18;
}

struct MarketConfig {
    MarketState state;
    uint16 maintenanceMarginBps;
    uint16 maxExecDeviationBps;
    uint16 maxConfidenceBps;
    uint32 maxMarkAgeSec;
    uint16 netSkewBpsOfV;
    uint16 grossOiBpsOfV;
    uint16 positionBpsOfV;
    uint128 absOiCapUsdg; // 0 = no absolute cap
    uint256 skewScaleE18;
    uint16 feeBps;
    uint16 borrowBaseBpsPerHour;
    uint16 minHoldSec;
    uint16 fallbackSpreadBps;
    uint16 frozenSpreadBps;
    SessionProfile[6] profiles; // indexed by IMarkOracle.Status
    // Open guard: the first minutes after the market enters Open, opens pay an extra spread and get a smaller ticket.
    uint32 openGuardSec; // 0 = no guard
    uint16 openGuardSpreadBps;
    uint16 openGuardPositionBpsOfV;
}

struct Market {
    MarketConfig cfg;
    bool exists;
    uint128 longOI; // USDG notional at entry
    uint128 shortOI;
    uint128 longSize; // token units E18
    uint128 shortSize;
    uint128 badDebt; // shortfall the waterfall could not cover
    uint128 marginTotal; // margin held for every open position, the most the Counter can collect from them
    uint64 lastAccrual;
    uint256 longIdx; // cumulative borrow, E18 fraction of notional
    uint256 shortIdx;
}

struct PendingMarket {
    MarketConfig cfg;
    uint64 eta;
}

struct Position {
    int256 size; // signed, token units E18
    uint256 entry; // E18
    uint128 margin; // USDG
    uint64 openedAt; // last time the position was opened or increased
    uint64 openedBlock;
    uint256 borrowSnap; // borrow index at the last settlement
}

struct Trade {
    address trader;
    bytes32 id;
    int256 delta;
    uint256 exec;
    uint256 fee;
    uint256 margin;
    uint256 maxLev;
    uint64 markSeq;
    uint8 path; // 0 quote, 1 order, 2 closeAtMark
    bool checkPrice;
    bool noProfit; // closing at a stale price: losses settle, profit is not paid
}

/// Everything the trade engine reads and writes, so it can live in a linked library.
struct State {
    IERC20 usdg;
    IMarkOracle oracle;
    ICounterVault vault;
    IBackstopFund backstop;
    IFirstLossTranche firstLoss;
    IFeeRouter feeRouter;
    IPayoutDesk payoutDesk;
    mapping(bytes32 => Market) markets;
    mapping(bytes32 => PendingMarket) pending;
    bytes32[] marketIds;
    mapping(address => mapping(bytes32 => Position)) positions;
    mapping(address => uint256) collateral;
    mapping(address => uint256) walletNotional;
    uint256 totalAbsNet;
    uint256 totalBadDebt;
    mapping(uint256 => uint256) profitInHour;
    mapping(address => mapping(bytes32 => uint64)) closedAt; // when the position last went to zero
    mapping(address => address) referrer;
}
