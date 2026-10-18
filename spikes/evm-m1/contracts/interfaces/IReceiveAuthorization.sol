// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev The restricted token surface used by AssuranceCoreSpike. The fixture
/// follows the ERC-3009 receiveWithAuthorization signature.
interface IReceiveAuthorization {
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
    ) external;
}
