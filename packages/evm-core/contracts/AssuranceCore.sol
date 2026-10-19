// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReceiveAuthorization} from "./interfaces/IReceiveAuthorization.sol";

/// @notice Non-upgradeable financial core for x402 service assurance.
contract AssuranceCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_AUTHORIZATION_SECONDS = 300;

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)"
    );
    bytes32 private constant POLICY_TYPEHASH = keccak256(
        "AssuredPolicyV1(bytes32 providerId,bytes32 policyId,address providerOwner,address providerPayout,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)"
    );

    address public immutable admin;
    address public immutable adjudicator;
    IERC20 public immutable token;
    bool public paused;

    uint256 public poolAssets;
    uint256 public totalPoolReserved;
    uint256 public totalProviderStake;
    uint256 public totalLockedStake;
    uint256 public coverageCount;
    uint256 public activeCoverageCount;

    enum Resolution {
        Reject,
        ProviderFault,
        PoolOnly
    }

    enum CoverageStatus {
        None,
        Active,
        ClaimPending,
        Refunded,
        Rejected,
        Expired
    }

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

    struct Provider {
        address owner;
        address payout;
        uint256 freeStake;
        uint256 lockedStake;
    }

    struct Policy {
        bytes32 providerId;
        bytes32 policyHash;
        uint16 premiumBps;
        uint16 stakeBps;
        uint16 withholdingBps;
        uint64 duration;
        bool poolOnlyAllowed;
    }

    struct Coverage {
        address payer;
        bytes32 providerId;
        bytes32 policyId;
        bytes32 policyHash;
        bytes32 requestHash;
        uint256 gross;
        uint256 premium;
        uint256 withheld;
        uint256 stakeLock;
        uint256 poolReservation;
        uint64 openedAt;
        uint64 expiresAt;
        bool poolOnlyAllowed;
        CoverageStatus status;
        bytes32 evidenceHash;
        bytes32 decisionHash;
        uint256 refundAmount;
        Resolution outcome;
    }

    mapping(bytes32 providerId => Provider provider) public providers;
    mapping(bytes32 policyId => Policy policy) public policies;
    mapping(bytes32 coverageId => Coverage coverage) public coverages;

    error Unauthorized();
    error InvalidArgument();
    error DuplicateId();
    error UnknownProvider();
    error UnknownPolicy();
    error InvalidIntent();
    error InvalidState();
    error InsufficientStake();
    error InsufficientPool();
    error ExactBalanceMismatch();
    error Insolvent();

    event ProviderRegistered(bytes32 indexed providerId, address indexed owner, address indexed payout);
    event PolicyRegistered(
        bytes32 indexed policyId,
        bytes32 indexed providerId,
        bytes32 policyHash,
        uint16 premiumBps,
        uint16 stakeBps,
        uint16 withholdingBps,
        uint64 duration,
        bool poolOnlyAllowed
    );
    event PauseUpdated(bool paused);
    event StakeDeposited(bytes32 indexed providerId, address indexed funder, uint256 amount);
    event PoolFunded(address indexed funder, uint256 amount);
    event StakeWithdrawn(bytes32 indexed providerId, address indexed owner, uint256 amount);
    event CoverageOpened(
        bytes32 indexed coverageId,
        address indexed payer,
        bytes32 indexed providerId,
        bytes32 policyId,
        bytes32 requestHash,
        uint256 gross,
        uint256 premium,
        uint256 withheld,
        uint256 net,
        uint256 stakeLock,
        uint256 poolReservation,
        uint64 expiresAt
    );
    event ClaimFiled(bytes32 indexed coverageId, address indexed payer, bytes32 evidenceHash);
    event ClaimFinalized(
        bytes32 indexed coverageId,
        Resolution outcome,
        uint256 refundAmount,
        bytes32 decisionHash
    );
    event CoverageExpired(bytes32 indexed coverageId, uint256 stakeReleased, uint256 poolReservationReleased);

    constructor(address token_, address admin_, address adjudicator_) {
        if (
            token_ == address(0) || token_.code.length == 0 || admin_ == address(0)
                || adjudicator_ == address(0) || admin_ == address(this) || adjudicator_ == address(this)
                || admin_ == token_ || adjudicator_ == token_
        ) revert InvalidArgument();
        token = IERC20(token_);
        admin = admin_;
        adjudicator = adjudicator_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function registerProvider(bytes32 providerId, address owner, address payout) external onlyAdmin {
        if (paused) revert InvalidState();
        if (
            providerId == bytes32(0) || providers[providerId].owner != address(0) || owner == address(0)
                || payout == address(0) || owner == address(this) || payout == address(this) || owner == address(token)
                || payout == address(token)
        ) revert InvalidArgument();
        providers[providerId] = Provider({owner: owner, payout: payout, freeStake: 0, lockedStake: 0});
        emit ProviderRegistered(providerId, owner, payout);
    }

    function registerPolicy(
        bytes32 policyId,
        bytes32 providerId,
        uint16 premiumBps,
        uint16 stakeBps,
        uint16 withholdingBps,
        uint64 duration,
        bool poolOnlyAllowed
    ) external onlyAdmin {
        if (paused) revert InvalidState();
        if (policyId == bytes32(0) || policies[policyId].providerId != bytes32(0)) revert DuplicateId();
        Provider storage provider = providers[providerId];
        if (provider.owner == address(0)) revert UnknownProvider();
        if (
            premiumBps > 9_999 || stakeBps > 10_000 || withholdingBps > 9_999 || duration == 0
        ) revert InvalidArgument();

        bytes32 policyHash = keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                providerId,
                policyId,
                provider.owner,
                provider.payout,
                premiumBps,
                stakeBps,
                withholdingBps,
                duration,
                poolOnlyAllowed
            )
        );
        policies[policyId] = Policy({
            providerId: providerId,
            policyHash: policyHash,
            premiumBps: premiumBps,
            stakeBps: stakeBps,
            withholdingBps: withholdingBps,
            duration: duration,
            poolOnlyAllowed: poolOnlyAllowed
        });
        emit PolicyRegistered(
            policyId, providerId, policyHash, premiumBps, stakeBps, withholdingBps, duration, poolOnlyAllowed
        );
    }

    function setPaused(bool paused_) external onlyAdmin {
        paused = paused_;
        emit PauseUpdated(paused_);
    }

    function hashIntent(AssuredIntent calldata intent) public pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, intent));
    }

    function quoteSettlement(bytes32 policyId, uint256 gross)
        public
        view
        returns (uint256 premium, uint256 withheld, uint256 net, uint256 stakeLock, uint256 poolReservation)
    {
        Policy storage policy = policies[policyId];
        if (policy.providerId == bytes32(0)) revert UnknownPolicy();
        if (gross < 2) revert InvalidArgument();

        premium = Math.mulDiv(gross, policy.premiumBps, BPS_DENOMINATOR);
        if (premium == 0) premium = 1;
        if (premium >= gross) revert InvalidArgument();
        withheld = Math.mulDiv(gross - premium, policy.withholdingBps, BPS_DENOMINATOR);
        net = gross - premium - withheld;
        if (net == 0) revert InvalidArgument();
        stakeLock = Math.mulDiv(gross, policy.stakeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        poolReservation = policy.poolOnlyAllowed ? gross : gross - stakeLock;
    }

    function settleAssured(AssuredIntent calldata intent, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (bytes32 coverageId)
    {
        if (paused) revert InvalidState();
        Policy storage policy = policies[intent.policyId];
        if (policy.providerId == bytes32(0)) revert UnknownPolicy();
        Provider storage provider = providers[policy.providerId];
        if (
            intent.chainId != block.chainid || intent.core != address(this) || intent.token != address(token)
                || intent.payer == address(0) || intent.payer == address(this) || intent.payer == address(token)
                || intent.payer == provider.payout || intent.providerId != policy.providerId
                || intent.policyHash != policy.policyHash || intent.requestHash == bytes32(0)
                || intent.payerSalt == bytes32(0) || intent.gross < 2 || intent.validAfter == 0
                || intent.validBefore <= intent.validAfter
                || intent.validBefore - intent.validAfter > MAX_AUTHORIZATION_SECONDS
                || block.timestamp <= intent.validAfter || block.timestamp >= intent.validBefore
        ) revert InvalidIntent();

        coverageId = hashIntent(intent);
        if (coverages[coverageId].status != CoverageStatus.None) revert DuplicateId();
        (uint256 premium, uint256 withheld, uint256 net, uint256 stakeLock, uint256 poolReservation) =
            quoteSettlement(intent.policyId, intent.gross);
        if (provider.freeStake + withheld < stakeLock) revert InsufficientStake();
        if (poolAssets + premium < totalPoolReserved + poolReservation) revert InsufficientPool();

        uint256 openedAt = block.timestamp;
        uint256 expiry = openedAt + uint256(policy.duration);
        if (expiry > type(uint64).max) revert InvalidArgument();
        uint64 openedAt64 = uint64(openedAt);
        uint64 expiresAt = uint64(expiry);

        uint256 payerBefore = token.balanceOf(intent.payer);
        uint256 coreBefore = token.balanceOf(address(this));
        uint256 payoutBefore = token.balanceOf(provider.payout);
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
        uint256 payoutAfterReceive = token.balanceOf(provider.payout);
        if (
            payerAfterReceive > payerBefore || payerBefore - payerAfterReceive != intent.gross
                || coreAfterReceive < coreBefore || coreAfterReceive - coreBefore != intent.gross
                || payoutAfterReceive != payoutBefore
        ) revert ExactBalanceMismatch();

        provider.freeStake = provider.freeStake + withheld - stakeLock;
        provider.lockedStake += stakeLock;
        totalProviderStake += withheld;
        totalLockedStake += stakeLock;
        poolAssets += premium;
        totalPoolReserved += poolReservation;
        coverageCount += 1;
        activeCoverageCount += 1;
        coverages[coverageId] = Coverage({
            payer: intent.payer,
            providerId: policy.providerId,
            policyId: intent.policyId,
            policyHash: policy.policyHash,
            requestHash: intent.requestHash,
            gross: intent.gross,
            premium: premium,
            withheld: withheld,
            stakeLock: stakeLock,
            poolReservation: poolReservation,
            openedAt: openedAt64,
            expiresAt: expiresAt,
            poolOnlyAllowed: policy.poolOnlyAllowed,
            status: CoverageStatus.Active,
            evidenceHash: bytes32(0),
            decisionHash: bytes32(0),
            refundAmount: 0,
            outcome: Resolution.Reject
        });
        token.safeTransfer(provider.payout, net);

        uint256 payerAfter = token.balanceOf(intent.payer);
        uint256 coreAfter = token.balanceOf(address(this));
        uint256 payoutAfter = token.balanceOf(provider.payout);
        if (
            payerAfter > payerBefore || payerBefore - payerAfter != intent.gross || coreAfter < coreBefore
                || coreAfter - coreBefore != premium + withheld || payoutAfter < payoutBefore
                || payoutAfter - payoutBefore != net
        ) revert ExactBalanceMismatch();
        _checkSolvency();

        emit CoverageOpened(
            coverageId,
            intent.payer,
            policy.providerId,
            intent.policyId,
            intent.requestHash,
            intent.gross,
            premium,
            withheld,
            net,
            stakeLock,
            poolReservation,
            expiresAt
        );
    }

    function depositStake(bytes32 providerId, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidArgument();
        Provider storage provider = providers[providerId];
        if (provider.owner == address(0)) revert UnknownProvider();
        _pullExact(msg.sender, amount);
        provider.freeStake += amount;
        totalProviderStake += amount;
        _checkSolvency();
        emit StakeDeposited(providerId, msg.sender, amount);
    }

    function fundPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidArgument();
        _pullExact(msg.sender, amount);
        poolAssets += amount;
        _checkSolvency();
        emit PoolFunded(msg.sender, amount);
    }

    function withdrawStake(bytes32 providerId, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidArgument();
        Provider storage provider = providers[providerId];
        if (provider.owner == address(0)) revert UnknownProvider();
        if (msg.sender != provider.owner) revert Unauthorized();
        if (provider.freeStake < amount) revert InsufficientStake();
        provider.freeStake -= amount;
        totalProviderStake -= amount;

        uint256 coreBefore = token.balanceOf(address(this));
        uint256 ownerBefore = token.balanceOf(provider.owner);
        token.safeTransfer(provider.owner, amount);
        uint256 coreAfter = token.balanceOf(address(this));
        uint256 ownerAfter = token.balanceOf(provider.owner);
        if (
            coreAfter > coreBefore || coreBefore - coreAfter != amount || ownerAfter < ownerBefore
                || ownerAfter - ownerBefore != amount
        ) revert ExactBalanceMismatch();
        _checkSolvency();
        emit StakeWithdrawn(providerId, provider.owner, amount);
    }

    function fileClaim(bytes32 coverageId, bytes32 evidenceHash) external nonReentrant {
        Coverage storage coverage = coverages[coverageId];
        if (
            coverage.status != CoverageStatus.Active || msg.sender != coverage.payer || evidenceHash == bytes32(0)
                || block.timestamp >= coverage.expiresAt
        ) revert InvalidState();
        coverage.evidenceHash = evidenceHash;
        coverage.status = CoverageStatus.ClaimPending;
        emit ClaimFiled(coverageId, msg.sender, evidenceHash);
    }

    function finalizeClaim(bytes32 coverageId, Resolution outcome, uint256 refundAmount, bytes32 decisionHash)
        external
        nonReentrant
    {
        if (msg.sender != adjudicator) revert Unauthorized();
        Coverage storage coverage = coverages[coverageId];
        if (coverage.status != CoverageStatus.ClaimPending || decisionHash == bytes32(0)) revert InvalidState();
        Provider storage provider = providers[coverage.providerId];

        if (outcome == Resolution.Reject) {
            if (refundAmount != 0) revert InvalidArgument();
            provider.freeStake += coverage.stakeLock;
            provider.lockedStake -= coverage.stakeLock;
            totalLockedStake -= coverage.stakeLock;
            coverage.status = CoverageStatus.Rejected;
        } else {
            if (refundAmount == 0 || refundAmount > coverage.gross) revert InvalidArgument();
            if (outcome == Resolution.ProviderFault) {
                uint256 lockConsumed = refundAmount < coverage.stakeLock ? refundAmount : coverage.stakeLock;
                uint256 remaining = refundAmount - lockConsumed;
                uint256 freeConsumed = remaining < provider.freeStake ? remaining : provider.freeStake;
                uint256 poolConsumed = remaining - freeConsumed;
                provider.freeStake = provider.freeStake - freeConsumed + coverage.stakeLock - lockConsumed;
                provider.lockedStake -= coverage.stakeLock;
                totalProviderStake -= lockConsumed + freeConsumed;
                totalLockedStake -= coverage.stakeLock;
                poolAssets -= poolConsumed;
            } else if (outcome == Resolution.PoolOnly) {
                if (!coverage.poolOnlyAllowed) revert InvalidArgument();
                poolAssets -= refundAmount;
                provider.freeStake += coverage.stakeLock;
                provider.lockedStake -= coverage.stakeLock;
                totalLockedStake -= coverage.stakeLock;
            } else {
                revert InvalidArgument();
            }
            coverage.status = CoverageStatus.Refunded;
            coverage.refundAmount = refundAmount;
        }

        coverage.outcome = outcome;
        coverage.decisionHash = decisionHash;
        totalPoolReserved -= coverage.poolReservation;
        activeCoverageCount -= 1;

        if (refundAmount > 0) _transferExact(coverage.payer, refundAmount);
        _checkSolvency();
        emit ClaimFinalized(coverageId, outcome, refundAmount, decisionHash);
    }

    function closeExpired(bytes32 coverageId) external nonReentrant {
        Coverage storage coverage = coverages[coverageId];
        if (coverage.status != CoverageStatus.Active || block.timestamp < coverage.expiresAt) revert InvalidState();
        Provider storage provider = providers[coverage.providerId];
        provider.freeStake += coverage.stakeLock;
        provider.lockedStake -= coverage.stakeLock;
        totalLockedStake -= coverage.stakeLock;
        totalPoolReserved -= coverage.poolReservation;
        activeCoverageCount -= 1;
        coverage.status = CoverageStatus.Expired;
        _checkSolvency();
        emit CoverageExpired(coverageId, coverage.stakeLock, coverage.poolReservation);
    }

    function _pullExact(address from, uint256 amount) private {
        if (from == address(0) || from == address(this) || from == address(token)) revert InvalidArgument();
        uint256 senderBefore = token.balanceOf(from);
        uint256 coreBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 senderAfter = token.balanceOf(from);
        uint256 coreAfter = token.balanceOf(address(this));
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount || coreAfter < coreBefore
                || coreAfter - coreBefore != amount
        ) revert ExactBalanceMismatch();
    }

    function _transferExact(address recipient, uint256 amount) private {
        uint256 coreBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 coreAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            coreAfter > coreBefore || coreBefore - coreAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert ExactBalanceMismatch();
    }

    function _checkSolvency() private view {
        if (
            token.balanceOf(address(this)) < poolAssets + totalProviderStake || poolAssets < totalPoolReserved
                || totalProviderStake < totalLockedStake
        ) revert Insolvent();
    }
}
