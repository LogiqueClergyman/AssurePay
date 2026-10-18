// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Test-only USDC-shaped token with ERC-3009 authorizations.
/// @dev The transfer failure, fee, and callback controls model rollback and
///      reentrancy cases for the M1 spike. They are not production token logic.
contract AuthorizationTokenMock is ERC20, EIP712 {
    bytes32 private constant _RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 private constant _TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 private constant _CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    address public immutable admin;
    mapping(address authorizer => mapping(bytes32 nonce => bool used))
        public authorizationState;

    bool public failTransfers;
    uint256 public transferFee;
    address public reentryTarget;
    bytes private _reentryData;
    bool public lastReentrySucceeded;
    bytes4 public lastReentrySelector;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AdminOnly();
    error InvalidRecipient();
    error InvalidAuthorizationTime();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSigner();
    error TransferFeeExceedsAmount();

    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {
        admin = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice USDC's signing-version accessor, separate from EIP712's domain.
    function version() external pure returns (string memory) {
        return "2";
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function mint(address to, uint256 amount) external onlyAdmin {
        _mint(to, amount);
    }

    function setFailTransfers(bool shouldFail) external onlyAdmin {
        failTransfers = shouldFail;
    }

    function setTransferFee(uint256 fee) external onlyAdmin {
        transferFee = fee;
    }

    /// @dev Configure a best-effort callback attempted after an ordinary transfer.
    function setReentry(address target, bytes calldata data) external onlyAdmin {
        reentryTarget = target;
        _reentryData = data;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (msg.sender != to) revert InvalidRecipient();
        _validateAuthorization(from, validAfter, validBefore, nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                _RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        _verifySigner(from, _hashTypedDataV4(structHash), v, r, s);

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        // Deliberately bypasses the ordinary-transfer failure/fee fixtures.
        _transfer(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _validateAuthorization(from, validAfter, validBefore, nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                _TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        _verifySigner(from, _hashTypedDataV4(structHash), v, r, s);

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (authorizer == address(0)) revert InvalidAuthorizationSigner();
        if (authorizationState[authorizer][nonce]) {
            revert AuthorizationAlreadyUsed();
        }

        bytes32 structHash = keccak256(
            abi.encode(_CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)
        );
        _verifySigner(authorizer, _hashTypedDataV4(structHash), v, r, s);

        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @dev A false return lets Core's checked ERC-20 transfer path revert.
    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        if (value < transferFee) revert TransferFeeExceedsAmount();

        uint256 fee = transferFee;
        _transfer(_msgSender(), to, value - fee);
        if (fee != 0) _burn(_msgSender(), fee);

        address target = reentryTarget;
        if (target != address(0)) {
            bytes memory returned;
            (lastReentrySucceeded, returned) = target.call(_reentryData);
            lastReentrySelector = bytes4(returned);
        }
        return true;
    }

    function _validateAuthorization(
        address authorizer,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view {
        if (authorizer == address(0)) revert InvalidAuthorizationSigner();
        if (block.timestamp <= validAfter || block.timestamp >= validBefore) {
            revert InvalidAuthorizationTime();
        }
        if (authorizationState[authorizer][nonce]) {
            revert AuthorizationAlreadyUsed();
        }
    }

    function _verifySigner(
        address expectedSigner,
        bytes32 digest,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private pure {
        if (expectedSigner == address(0) || ECDSA.recover(digest, v, r, s) != expectedSigner) {
            revert InvalidAuthorizationSigner();
        }
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert AdminOnly();
        _;
    }
}
