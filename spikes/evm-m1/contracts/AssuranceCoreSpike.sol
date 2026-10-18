// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReceiveAuthorization} from "./interfaces/IReceiveAuthorization.sol";

/// @notice Disposable fixed-economics M1 fixture, not a production assurance core.
contract AssuranceCoreSpike is ReentrancyGuard {
    using SafeERC20 for IERC20;

    string private constant INTENT_TYPE_LITERAL =
        "AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)";
    bytes32 private constant INTENT_TYPEHASH = keccak256(bytes(INTENT_TYPE_LITERAL));
    uint256 public constant FIXTURE_GROSS = 100;
    uint256 public constant FIXTURE_NET = 93;
    uint256 public constant FIXTURE_PREMIUM = 7;
    uint256 public constant MAX_AUTHORIZATION_SECONDS = 300;

    address public immutable admin;
    IERC20 public immutable token;
    address public immutable providerPayout;
    bytes32 public immutable providerId;
    bytes32 public immutable policyId;
    bytes32 public immutable policyHash;

    bool public admissionEnabled = true;
    bool public failAfterTransfer;

    struct AssuredIntent {
        uint256 chainId;
        address core;
        address token;
        address payer;
        bytes32 providerId;
        bytes32 policyId;
        bytes32 policyHash;
        bytes32 requestHash;
        uint256 gross;
        bytes32 payerSalt;
        uint256 validAfter;
        uint256 validBefore;
    }

    struct Coverage {
        address payer;
        bytes32 requestHash;
        uint256 gross;
    }

    mapping(bytes32 coverageId => Coverage coverage) public coverages;
    uint256 public coverageCount;
    uint256 public premiumReserve;

    error InvalidIntent();
    error AdmissionDisabled();
    error DuplicateCoverage(bytes32 coverageId);
    error ExactBalanceMismatch();
    error ForcedPostconditionFailure();
    error AdminOnly();
    error InvalidConstructorArgument();

    event CoverageOpened(
        bytes32 indexed coverageId,
        address indexed payer,
        bytes32 indexed providerId,
        bytes32 policyId,
        bytes32 requestHash,
        uint256 gross,
        uint256 net,
        uint256 premium
    );

    constructor(
        address token_,
        address providerPayout_,
        bytes32 providerId_,
        bytes32 policyId_,
        bytes32 policyHash_
    ) {
        if (
            token_ == address(0) || token_.code.length == 0 || providerPayout_ == address(0)
                || providerPayout_ == address(this) || providerPayout_ == token_ || providerId_ == bytes32(0)
                || policyId_ == bytes32(0)
                || policyHash_ == bytes32(0)
        ) revert InvalidConstructorArgument();

        admin = msg.sender;
        token = IERC20(token_);
        providerPayout = providerPayout_;
        providerId = providerId_;
        policyId = policyId_;
        policyHash = policyHash_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert AdminOnly();
        _;
    }

    function setAdmissionEnabled(bool enabled) external onlyAdmin {
        admissionEnabled = enabled;
    }

    function setFailAfterTransfer(bool enabled) external onlyAdmin {
        failAfterTransfer = enabled;
    }

    /// @dev For a static tuple, abi.encode(typehash, intent) matches the TS field sequence.
    function hashIntent(AssuredIntent calldata intent) public pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, intent));
    }

    function settleAssured(AssuredIntent calldata intent, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (bytes32 coverageId)
    {
        if (!admissionEnabled) revert AdmissionDisabled();
        if (
            intent.chainId != block.chainid || intent.core != address(this) || intent.token != address(token)
                || intent.payer == address(0) || intent.payer == address(this)
                || intent.payer == providerPayout || intent.providerId != providerId || intent.policyId != policyId
                || intent.policyHash != policyHash || intent.requestHash == bytes32(0)
                || intent.payerSalt == bytes32(0) || intent.gross != FIXTURE_GROSS
                || intent.validAfter == 0 || intent.validBefore <= intent.validAfter
                || intent.validBefore - intent.validAfter > MAX_AUTHORIZATION_SECONDS
                || block.timestamp <= intent.validAfter || block.timestamp >= intent.validBefore
        ) revert InvalidIntent();

        coverageId = hashIntent(intent);
        if (coverages[coverageId].payer != address(0)) revert DuplicateCoverage(coverageId);

        uint256 payerBefore = token.balanceOf(intent.payer);
        uint256 coreBefore = token.balanceOf(address(this));
        uint256 payoutBefore = token.balanceOf(providerPayout);

        IReceiveAuthorization(address(token)).receiveWithAuthorization(
            intent.payer,
            address(this),
            intent.gross,
            intent.validAfter,
            intent.validBefore,
            coverageId,
            v,
            r,
            s
        );

        uint256 payerAfterReceive = token.balanceOf(intent.payer);
        uint256 coreAfterReceive = token.balanceOf(address(this));
        uint256 payoutAfterReceive = token.balanceOf(providerPayout);
        if (
            payerAfterReceive > payerBefore || payerBefore - payerAfterReceive != intent.gross
                || coreAfterReceive < coreBefore || coreAfterReceive - coreBefore != intent.gross
                || payoutAfterReceive != payoutBefore
        ) revert ExactBalanceMismatch();

        coverages[coverageId] = Coverage({payer: intent.payer, requestHash: intent.requestHash, gross: intent.gross});
        coverageCount += 1;
        premiumReserve += FIXTURE_PREMIUM;

        token.safeTransfer(providerPayout, FIXTURE_NET);

        uint256 payerAfter = token.balanceOf(intent.payer);
        uint256 coreAfter = token.balanceOf(address(this));
        uint256 payoutAfter = token.balanceOf(providerPayout);
        if (
            payerAfter > payerBefore || payerBefore - payerAfter != intent.gross
                || coreAfter < coreBefore || coreAfter - coreBefore != FIXTURE_PREMIUM
                || payoutAfter < payoutBefore || payoutAfter - payoutBefore != FIXTURE_NET
        ) revert ExactBalanceMismatch();

        if (failAfterTransfer) revert ForcedPostconditionFailure();

        _emitCoverageOpened(coverageId, intent);
    }

    function _emitCoverageOpened(bytes32 coverageId, AssuredIntent calldata intent) private {
        emit CoverageOpened(
            coverageId,
            intent.payer,
            providerId,
            policyId,
            intent.requestHash,
            intent.gross,
            FIXTURE_NET,
            FIXTURE_PREMIUM
        );
    }
}
