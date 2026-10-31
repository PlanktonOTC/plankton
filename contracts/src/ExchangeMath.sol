// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Pure helpers shared by Exchange and ExchangeLib. All internal, so they inline.
library ExchangeMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant E18 = 1e18;
    uint256 internal constant USDG_SCALE = 1e12;

    function abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// Notional in USDG (6dp) of a size in token units (E18) at a price (E18).
    function notional(uint256 sizeAbs, uint256 priceE18) internal pure returns (uint256) {
        return sizeAbs * priceE18 / E18 / USDG_SCALE;
    }

    function pnl(bool isLong, uint256 entry, uint256 price, uint256 size) internal pure returns (int256) {
        int256 diff = int256(price) - int256(entry);
        if (!isLong) diff = -diff;
        return diff * int256(size) / int256(E18) / int256(USDG_SCALE);
    }

    /// fill = mark * (1 + (skewBefore + skewAfter) / 2 / skewScale). Skew is long minus short notional, E18 USD.
    function skewFill(uint256 mark, int256 before_, int256 after_, uint256 scale) internal pure returns (uint256) {
        if (scale == 0) return mark;
        int256 impact = ((before_ + after_) / 2) * int256(E18) / int256(scale);
        int256 fill = int256(mark) * (int256(E18) + impact) / int256(E18);
        return fill > 0 ? uint256(fill) : 0;
    }

    function diffBps(uint256 a, uint256 ref) internal pure returns (uint256) {
        if (ref == 0) return type(uint256).max;
        return (a > ref ? a - ref : ref - a) * BPS / ref;
    }

    function isReducing(int256 size, int256 delta) internal pure returns (bool) {
        return size != 0 && delta != 0 && (size > 0) != (delta > 0) && abs(delta) <= abs(size);
    }

    function fractionClose(int256 size, uint256 bps) internal pure returns (int256) {
        int256 portion = int256(abs(size) * bps / BPS);
        return size > 0 ? -portion : portion;
    }

    function sub128(uint128 a, uint256 b) internal pure returns (uint128) {
        return b >= a ? 0 : a - uint128(b);
    }
}
