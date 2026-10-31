// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMarkOracle, IAggregatorV3} from "./interfaces/Interfaces.sol";

/// @notice Signed price attestations, bounded on-chain by Chainlink.
/// A leaked signer key can move a mark only inside `bandBps` of a fresh Chainlink answer; anything outside needs a quorum.
/// The owner is an EOA: tightening is instant, loosening and new signers wait 24h.
contract MarkOracle is IMarkOracle, EIP712, Ownable2Step {
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 marketId,uint256 markE18,uint256 refCloseE18,uint16 confidenceBps,uint8 status,uint64 sequence,uint64 observedAt,uint64 expiry)"
    );
    uint256 public constant CHANGE_DELAY = 24 hours;
    uint8 public constant MAX_SIGNERS = 3;
    uint256 private constant BPS = 10_000;
    uint256 private constant CLOCK_SKEW = 5; // seconds of tolerated future observedAt

    struct PendingConfig {
        OracleConfig config;
        uint64 effectiveAt;
    }

    mapping(address => bool) public isSigner;
    uint8 public signerCount;
    mapping(address => uint64) public signerActivatesAt;

    mapping(bytes32 => OracleConfig) private _config;
    mapping(bytes32 => bool) public configured;
    mapping(bytes32 => PendingConfig) private _pending;
    mapping(bytes32 => Mark) private _mark;
    mapping(bytes32 => uint8) public consistentMarks;

    error NotConfigured();
    error StaleSequence();
    error Expired();
    error TooOld();
    error FutureObservation();
    error BadAttestation();
    error BadSignature();
    error QuorumRequired(uint256 have, uint256 need);
    error InvalidConfig();
    error NothingPending();
    error TooEarly();
    error SignerLimit();
    error AlreadySigner();

    constructor(address owner_, address[] memory initialSigners) EIP712("PlanktonMark", "1") Ownable(owner_) {
        for (uint256 i; i < initialSigners.length; ++i) {
            if (initialSigners[i] == address(0) || isSigner[initialSigners[i]]) revert BadSignature();
            if (signerCount == MAX_SIGNERS) revert SignerLimit();
            isSigner[initialSigners[i]] = true;
            ++signerCount;
            emit SignerChanged(initialSigners[i], true, uint64(block.timestamp));
        }
    }

    // ---------------------------------------------------------------- publishing

    function publish(Attestation calldata a, bytes[] calldata sigs) external {
        if (!configured[a.marketId]) revert NotConfigured();
        OracleConfig memory c = _config[a.marketId];
        Mark storage m = _mark[a.marketId];

        if (a.sequence <= m.sequence) revert StaleSequence();
        if (a.expiry < block.timestamp) revert Expired();
        if (a.observedAt > block.timestamp + CLOCK_SKEW) revert FutureObservation();
        if (block.timestamp > uint256(a.observedAt) + c.maxAgeSec) revert TooOld();
        if (a.markE18 == 0 || a.status == Status.Unset) revert BadAttestation();

        uint256 valid = _countSigners(a, sigs);
        if (valid == 0) revert BadSignature();

        // Does this mark need more than one signer?
        bool needQuorum;
        if (a.status == Status.Open || a.status == Status.Extended) {
            (uint256 cl, uint64 clAt) = _chainlink(c.chainlinkFeed);
            bool fresh = clAt != 0 && block.timestamp <= uint256(clAt) + c.chainlinkMaxAgeSec;
            needQuorum = !fresh || _diffBps(a.markE18, cl) > c.bandBps;
        } else if (m.priceE18 != 0) {
            // Weekend, Frozen, Halted: Chainlink is not a usable bound, so the mark may only hold near the last one.
            needQuorum = _diffBps(a.markE18, m.priceE18) > c.jumpBps;
        }
        bool quorum = valid >= c.quorumOutsideBand;
        if (needQuorum && !quorum) revert QuorumRequired(valid, c.quorumOutsideBand);

        // Jump breaker and re-anchor.
        bool breaker = m.breaker;
        if (m.priceE18 != 0 && _diffBps(a.markE18, m.priceE18) > c.jumpBps) {
            if (quorum) {
                if (breaker) emit Reanchored(a.marketId, a.markE18);
                breaker = false;
            } else {
                breaker = true;
                emit BreakerSet(a.marketId, m.priceE18, a.markE18);
            }
            consistentMarks[a.marketId] = 0;
        } else if (breaker) {
            uint8 n = consistentMarks[a.marketId] + 1;
            if (quorum || n >= c.reanchorConfirmations) {
                breaker = false;
                n = 0;
                emit Reanchored(a.marketId, a.markE18);
            }
            consistentMarks[a.marketId] = n;
        }

        uint64 observed = a.observedAt > block.timestamp ? uint64(block.timestamp) : a.observedAt;
        _mark[a.marketId] = Mark(a.markE18, a.confidenceBps, a.status, a.sequence, observed, breaker);
        emit MarkPublished(a.marketId, a.markE18, a.status, a.sequence, a.confidenceBps, breaker);
    }

    function markOf(bytes32 marketId) external view returns (Mark memory) {
        return _mark[marketId];
    }

    function configOf(bytes32 marketId) external view returns (OracleConfig memory) {
        return _config[marketId];
    }

    function chainlinkPrice(bytes32 marketId) external view returns (uint256 priceE18, uint64 updatedAt) {
        return _chainlink(_config[marketId].chainlinkFeed);
    }

    /// EIP-712 digest signers must sign.
    function hashAttestation(Attestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.marketId,
                    a.markE18,
                    a.refCloseE18,
                    a.confidenceBps,
                    uint8(a.status),
                    a.sequence,
                    a.observedAt,
                    a.expiry
                )
            )
        );
    }

    // ---------------------------------------------------------------- config (tighten instantly, loosen after 24h)

    function scheduleConfig(bytes32 marketId, OracleConfig calldata c) external onlyOwner {
        if (
            c.chainlinkFeed == address(0) || c.bandBps == 0 || c.jumpBps == 0 || c.maxAgeSec == 0 || c.chainlinkMaxAgeSec == 0
                || c.reanchorConfirmations == 0 || c.quorumOutsideBand == 0 || c.quorumOutsideBand > MAX_SIGNERS
        ) revert InvalidConfig();

        if (!configured[marketId]) {
            _config[marketId] = c;
            configured[marketId] = true;
            emit ConfigScheduled(marketId, c, uint64(block.timestamp));
        } else if (_isLoosening(_config[marketId], c)) {
            uint64 eta = uint64(block.timestamp + CHANGE_DELAY);
            _pending[marketId] = PendingConfig(c, eta);
            emit ConfigScheduled(marketId, c, eta);
        } else {
            _config[marketId] = c;
            delete _pending[marketId]; // a tightening cancels any queued loosening
            emit ConfigScheduled(marketId, c, uint64(block.timestamp));
        }
    }

    function applyConfig(bytes32 marketId) external {
        PendingConfig memory p = _pending[marketId];
        if (p.effectiveAt == 0) revert NothingPending();
        if (block.timestamp < p.effectiveAt) revert TooEarly();
        _config[marketId] = p.config;
        delete _pending[marketId];
    }

    function pendingConfigOf(bytes32 marketId) external view returns (PendingConfig memory) {
        return _pending[marketId];
    }

    // ---------------------------------------------------------------- signers (remove instantly, add after 24h)

    function setSigner(address signer, bool allowed) external onlyOwner {
        if (!allowed) {
            if (isSigner[signer]) {
                isSigner[signer] = false;
                --signerCount;
            }
            delete signerActivatesAt[signer];
            emit SignerChanged(signer, false, uint64(block.timestamp));
            return;
        }
        if (signer == address(0) || isSigner[signer]) revert AlreadySigner();
        uint64 eta = uint64(block.timestamp + CHANGE_DELAY);
        signerActivatesAt[signer] = eta;
        emit SignerChanged(signer, true, eta);
    }

    function applySigner(address signer) external {
        uint64 eta = signerActivatesAt[signer];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TooEarly();
        if (signerCount == MAX_SIGNERS) revert SignerLimit();
        delete signerActivatesAt[signer];
        isSigner[signer] = true;
        ++signerCount;
    }

    // ---------------------------------------------------------------- internals

    /// Signatures must be ordered by ascending signer address, which also rules out duplicates.
    function _countSigners(Attestation calldata a, bytes[] calldata sigs) private view returns (uint256 n) {
        bytes32 digest = hashAttestation(a);
        address last;
        for (uint256 i; i < sigs.length; ++i) {
            address s = ECDSA.recover(digest, sigs[i]);
            if (!isSigner[s] || s <= last) revert BadSignature();
            last = s;
            ++n;
        }
    }

    function _chainlink(address feed) private view returns (uint256 priceE18, uint64 updatedAt) {
        if (feed == address(0)) return (0, 0);
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 upd, uint80) {
            if (answer <= 0) return (0, 0);
            uint8 dec;
            try IAggregatorV3(feed).decimals() returns (uint8 d) {
                dec = d;
            } catch {
                return (0, 0);
            }
            priceE18 = dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
            updatedAt = uint64(upd);
        } catch {
            return (0, 0);
        }
    }

    function _diffBps(uint256 a, uint256 ref) private pure returns (uint256) {
        if (ref == 0) return type(uint256).max;
        return (a > ref ? a - ref : ref - a) * BPS / ref;
    }

    function _isLoosening(OracleConfig memory o, OracleConfig calldata n) private pure returns (bool) {
        return n.chainlinkFeed != o.chainlinkFeed || n.bandBps > o.bandBps || n.jumpBps > o.jumpBps || n.maxAgeSec > o.maxAgeSec
            || n.chainlinkMaxAgeSec > o.chainlinkMaxAgeSec || n.liqAgreementBps > o.liqAgreementBps
            || n.reanchorConfirmations < o.reanchorConfirmations || n.quorumOutsideBand < o.quorumOutsideBand;
    }
}
