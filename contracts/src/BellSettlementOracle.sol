// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Quorum-signed, independently sourced reference closes and Bell expiry settlements.
/// The signatures attest to off-chain licensed source observations; this contract checks their consistency on-chain.
contract BellSettlementOracle is EIP712, Ownable2Step {
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_REFERENCE_AGE = 48 hours;
    uint256 public constant MAX_CLOSE_PUBLICATION_DELAY = 10 days;
    uint256 public constant TWAP_WINDOW = 30 minutes;
    uint8 public constant REQUIRED_SIGNERS = 2;

    bytes32 private constant REFERENCE_TYPEHASH = keccak256(
        "SeriesReference(bytes32 marketId,uint64 expiry,uint256 sourcePriceA,uint256 sourcePriceB,bytes32 sourceIdA,bytes32 sourceIdB,uint64 observedAtA,uint64 observedAtB,uint64 nonce)"
    );
    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes32 marketId,uint64 expiry,uint256 closingPriceE18,uint256 markA,uint256 markB,uint256 markC,uint256 twap30mE18,uint64 marksObservedAt,uint64 closeObservedAt,uint64 twapStart,uint64 twapEnd,bool halted,uint256 fallbackMarkE18,uint64 fallbackObservedAt,uint64 nonce)"
    );

    struct Reference {
        uint256 closeE18;
        uint64 expiry;
        uint64 observedAt;
        bool exists;
    }

    struct ReferenceReport {
        bytes32 marketId;
        uint64 expiry;
        uint256 sourcePriceA;
        uint256 sourcePriceB;
        bytes32 sourceIdA;
        bytes32 sourceIdB;
        uint64 observedAtA;
        uint64 observedAtB;
        uint64 nonce;
    }

    struct SettlementReport {
        bytes32 marketId;
        uint64 expiry;
        uint256 closingPriceE18;
        uint256 markA;
        uint256 markB;
        uint256 markC;
        uint256 twap30mE18;
        uint64 marksObservedAt;
        uint64 closeObservedAt;
        uint64 twapStart;
        uint64 twapEnd;
        bool halted;
        uint256 fallbackMarkE18;
        uint64 fallbackObservedAt;
        uint256 nonce;
    }

    mapping(address => bool) public isSigner;
    mapping(bytes32 => Reference) private _references;
    mapping(bytes32 => uint256) private _settlements;
    mapping(bytes32 => bool) public settlementResolved;
    mapping(uint256 => bool) public usedSettlementNonce;

    event SignerChanged(address indexed signer, bool allowed);
    event ReferencePublished(bytes32 indexed marketId, uint64 indexed expiry, uint256 closeE18, bytes32 sourceA, bytes32 sourceB);
    event SettlementPublished(bytes32 indexed marketId, uint64 indexed expiry, uint256 settlementE18, bool usedTwap, bool haltedFallback);

    error ZeroAddress();
    error BadReference();
    error ReferenceExists();
    error ReferenceMissing();
    error BadSettlement();
    error AlreadySettled();
    error BadSignatures();
    error NonceUsed();

    constructor(address owner_, address[3] memory signers_) EIP712("Plankton Bell Settlement", "1") Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        for (uint256 i; i < signers_.length; ++i) {
            if (signers_[i] == address(0)) revert ZeroAddress();
            if (isSigner[signers_[i]]) revert BadSignatures();
            isSigner[signers_[i]] = true;
            emit SignerChanged(signers_[i], true);
        }
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = allowed;
        emit SignerChanged(signer, allowed);
    }

    function publishReference(ReferenceReport calldata r, bytes[] calldata signatures) external {
        bytes32 key = seriesKey(r.marketId, r.expiry);
        if (_references[key].exists) revert ReferenceExists();
        if (
            r.marketId == bytes32(0) || r.expiry <= block.timestamp || r.sourcePriceA == 0 || r.sourcePriceB == 0
                || r.sourceIdA == bytes32(0) || r.sourceIdB == bytes32(0) || r.sourceIdA == r.sourceIdB
                || r.observedAtA > block.timestamp || r.observedAtB > block.timestamp
                || block.timestamp - r.observedAtA > MAX_REFERENCE_AGE || block.timestamp - r.observedAtB > MAX_REFERENCE_AGE
        ) revert BadReference();

        uint256 close = r.sourcePriceA / 2 + r.sourcePriceB / 2 + (r.sourcePriceA % 2 + r.sourcePriceB % 2) / 2;
        uint16 tolerance = close > 3e18 ? 500 : 1_000;
        if (!_within(r.sourcePriceA, r.sourcePriceB, tolerance)) revert BadReference();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            REFERENCE_TYPEHASH, r.marketId, r.expiry, r.sourcePriceA, r.sourcePriceB, r.sourceIdA,
            r.sourceIdB, r.observedAtA, r.observedAtB, r.nonce
        )));
        _checkSignatures(digest, signatures);

        _references[key] = Reference(uint256(close), r.expiry, uint64((uint256(r.observedAtA) + r.observedAtB) / 2), true);
        emit ReferencePublished(r.marketId, r.expiry, close, r.sourceIdA, r.sourceIdB);
    }

    function publishSettlement(SettlementReport calldata r, bytes[] calldata signatures) external {
        bytes32 key = seriesKey(r.marketId, r.expiry);
        Reference memory ref = _references[key];
        if (!ref.exists) revert ReferenceMissing();
        if (settlementResolved[key]) revert AlreadySettled();
        if (block.timestamp < r.expiry) revert BadSettlement();

        bool useTwap;
        bool fallbackUsed;
        uint256 finalPrice;
        if (r.halted) {
            if (
                block.timestamp < uint256(r.expiry) + MAX_CLOSE_PUBLICATION_DELAY || r.fallbackMarkE18 == 0
                    || r.fallbackObservedAt > r.expiry || uint256(r.fallbackObservedAt) + MAX_REFERENCE_AGE < r.expiry
            ) revert BadSettlement();
            finalPrice = r.fallbackMarkE18;
            fallbackUsed = true;
        } else {
            if (block.timestamp > uint256(r.expiry) + MAX_CLOSE_PUBLICATION_DELAY) revert BadSettlement();
            if (
                r.closingPriceE18 == 0 || r.markA == 0 || r.markB == 0 || r.markC == 0 || r.twap30mE18 == 0
                    || r.marksObservedAt < uint256(r.expiry) - TWAP_WINDOW || r.marksObservedAt > uint256(r.expiry) + 10 minutes
                    || r.closeObservedAt < r.expiry || r.closeObservedAt > uint256(r.expiry) + 10 minutes
                    || r.twapStart > uint256(r.expiry) - TWAP_WINDOW
                    || r.twapStart < uint256(r.expiry) - TWAP_WINDOW - 10 minutes
                    || r.twapEnd < r.expiry || r.twapEnd > uint256(r.expiry) + 10 minutes
            ) revert BadSettlement();
            uint256 median = _median(r.markA, r.markB, r.markC);
            uint16 tolerance = ref.closeE18 > 3e18 ? 500 : 1_000;
            if (!_within(r.closingPriceE18, median, tolerance) || !_within(r.closingPriceE18, r.twap30mE18, tolerance)) {
                finalPrice = r.twap30mE18;
                useTwap = true;
            } else {
                finalPrice = r.closingPriceE18;
            }
        }

        if (r.nonce > type(uint64).max || usedSettlementNonce[r.nonce]) revert NonceUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            SETTLEMENT_TYPEHASH, r.marketId, r.expiry, r.closingPriceE18, r.markA, r.markB, r.markC,
            r.twap30mE18, r.marksObservedAt, r.closeObservedAt, r.twapStart, r.twapEnd,
            r.halted, r.fallbackMarkE18, r.fallbackObservedAt, uint64(r.nonce)
        )));
        _checkSignatures(digest, signatures);
        usedSettlementNonce[r.nonce] = true;
        _settlements[key] = finalPrice;
        settlementResolved[key] = true;
        emit SettlementPublished(r.marketId, r.expiry, finalPrice, useTwap, fallbackUsed);
    }

    function referenceOf(bytes32 marketId, uint64 expiry) external view returns (uint256 closeE18, uint64 observedAt, bool exists) {
        Reference memory r = _references[seriesKey(marketId, expiry)];
        return (r.closeE18, r.observedAt, r.exists);
    }

    function settlementOf(bytes32 marketId, uint64 expiry) external view returns (uint256 priceE18, bool resolved) {
        bytes32 key = seriesKey(marketId, expiry);
        return (_settlements[key], settlementResolved[key]);
    }

    function seriesKey(bytes32 marketId, uint64 expiry) public pure returns (bytes32) {
        return keccak256(abi.encode(marketId, expiry));
    }

    function _checkSignatures(bytes32 digest, bytes[] calldata signatures) private view {
        if (signatures.length < REQUIRED_SIGNERS || signatures.length > 3) revert BadSignatures();
        address previous;
        uint256 valid;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= previous || !isSigner[signer]) revert BadSignatures();
            previous = signer;
            ++valid;
        }
        if (valid < REQUIRED_SIGNERS) revert BadSignatures();
    }

    function _within(uint256 a, uint256 b, uint256 toleranceBps) private pure returns (bool) {
        if (b == 0) return false;
        uint256 delta = a > b ? a - b : b - a;
        // Avoid overflowing on malformed, extremely large signed prices.
        return delta <= b / BPS * toleranceBps + (b % BPS) * toleranceBps / BPS;
    }

    function _median(uint256 a, uint256 b, uint256 c) private pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return b;
    }
}
