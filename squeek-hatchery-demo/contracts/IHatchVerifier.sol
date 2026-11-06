// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// All fields must be signed together by a future session validation service.
struct HatchResult {
    uint256 chainId;
    address proxy;
    uint256 tokenId;
    address owner;
    bytes32 resultHash;
    uint256 nonce;
    uint256 expiry;
}

interface IHatchVerifier {
    function verify(HatchResult calldata result, bytes calldata signature) external view returns (bool);
}
