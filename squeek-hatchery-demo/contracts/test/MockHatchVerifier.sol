// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IHatchVerifier, HatchResult} from "../IHatchVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
/// TEST ONLY: recovers a fixture signer; does NOT validate hardware, sessions or gameplay.
contract MockHatchVerifier is IHatchVerifier {
    address public immutable signer;
    constructor(address fixtureSigner) { signer = fixtureSigner; }
    function verify(HatchResult calldata result, bytes calldata signature) external view returns (bool) {
        bytes32 digest = keccak256(abi.encode(result));
        return ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == signer;
    }
}
