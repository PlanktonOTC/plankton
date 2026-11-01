// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IAggregatorV3} from "../../src/interfaces/Interfaces.sol";

/// USDG stand-in: 6 decimals, EIP-2612 permit, anyone can mint (tests only).
contract MockUSDG is ERC20Permit {
    constructor() ERC20("Global Dollar", "USDG") ERC20Permit("Global Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Chainlink feed stand-in with 8 decimals and a settable answer and update time.
contract MockFeed is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// What the vault asks the Exchange, with settable answers, for testing the vault alone.
contract MockExchangeView {
    uint256 public epoch = 1;
    int256 public pnl;
    uint256 public reserve;
    bool public fresh = true;

    function setFresh(bool f) external {
        fresh = f;
    }

    function navPricesFresh() external view returns (bool) {
        return fresh;
    }

    bool public openInterest = true;

    function setOpenInterest(bool v) external {
        openInterest = v;
    }

    function hasOpenInterest() external view returns (bool) {
        return openInterest;
    }

    function bump() external {
        ++epoch;
    }

    function setPnl(int256 p) external {
        pnl = p;
    }

    function setReserve(uint256 r) external {
        reserve = r;
    }

    function markEpoch() external view returns (uint256) {
        return epoch;
    }

    function traderUnrealizedPnlUsdg() external view returns (int256) {
        return pnl;
    }

    function counterReserveUsdg() external view returns (uint256) {
        return reserve;
    }
}
