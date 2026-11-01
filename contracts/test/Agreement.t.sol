// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ExchangeMath as M} from "../src/ExchangeMath.sol";

/// The backend (TypeScript) and the contracts must compute the same prices, notionals, PnL and fees, to the last unit.
/// Regenerate the vectors with `bun run vectors` whenever the TypeScript math changes.
contract AgreementTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("test/vectors.json");
    }

    function _key(string memory arr, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".", arr, "[", vm.toString(i), "].", field);
    }

    function _n(string memory arr) internal view returns (uint256 n) {
        while (vm.keyExists(json, _key(arr, n, "expected"))) ++n;
    }

    function _u(string memory arr, uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, _key(arr, i, field)));
    }

    function _i(string memory arr, uint256 i, string memory field) internal view returns (int256) {
        return vm.parseInt(vm.parseJsonString(json, _key(arr, i, field)));
    }

    function test_skewFillMatchesTheBackend() public view {
        uint256 n = _n("skewFill");
        assertGt(n, 100, "vectors were generated");
        for (uint256 i; i < n; ++i) {
            uint256 got = M.skewFill(
                _u("skewFill", i, "mark"),
                _i("skewFill", i, "before"),
                _i("skewFill", i, "after"),
                _u("skewFill", i, "scale")
            );
            assertEq(got, _u("skewFill", i, "expected"), string.concat("skew fill vector ", vm.toString(i)));
        }
    }

    function test_notionalMatchesTheBackend() public view {
        uint256 n = _n("notional");
        assertGt(n, 10);
        for (uint256 i; i < n; ++i) {
            assertEq(
                M.notional(_u("notional", i, "size"), _u("notional", i, "price")),
                _u("notional", i, "expected"),
                string.concat("notional vector ", vm.toString(i))
            );
        }
    }

    function test_profitAndLossMatchesTheBackend() public view {
        uint256 n = _n("pnl");
        assertGt(n, 50);
        for (uint256 i; i < n; ++i) {
            bool isLong = vm.parseJsonBool(json, _key("pnl", i, "long"));
            int256 got = M.pnl(isLong, _u("pnl", i, "entry"), _u("pnl", i, "price"), _u("pnl", i, "size"));
            assertEq(got, _i("pnl", i, "expected"), string.concat("pnl vector ", vm.toString(i)));
        }
    }

    function test_partialCloseSizesMatchTheBackend() public view {
        uint256 n = _n("fractionClose");
        assertGt(n, 10);
        for (uint256 i; i < n; ++i) {
            assertEq(
                M.fractionClose(_i("fractionClose", i, "size"), _u("fractionClose", i, "bps")),
                _i("fractionClose", i, "expected"),
                string.concat("close vector ", vm.toString(i))
            );
        }
    }

    function test_feesMatchTheBackend() public view {
        uint256 n = _n("fee");
        assertGt(n, 5);
        for (uint256 i; i < n; ++i) {
            // The contract takes fee = notional * feeBps / 10,000, the same as the backend's tradeFeeUsdg.
            assertEq(
                _u("fee", i, "notional") * _u("fee", i, "bps") / 10_000,
                _u("fee", i, "expected"),
                string.concat("fee vector ", vm.toString(i))
            );
        }
    }

    function test_skewScaleMatchesTheDeployScript() public view {
        uint256 n = _n("skewScale");
        assertEq(n, 4);
        for (uint256 i; i < n; ++i) {
            // Same formula as ConfigureMarkets and Base: cap (USDG) -> E18, x 10,000, / (2 x 75 bp).
            assertEq(_u("skewScale", i, "cap") * 1e12 * 10_000 / 150, _u("skewScale", i, "expected"));
        }
    }
}
