// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IHatchVerifier, HatchResult} from "./IHatchVerifier.sol";

/// @notice TEST SOURCE ONLY. Predictable seeds; one address is not one human.
/// The admin can replace the verifier and upgrade ALL rules. Not cheat-proof.
/// OZ regular ERC721/Ownable storage is initialized explicitly: constructors run only
/// in the implementation. Keep this exact inheritance/storage layout across upgrades.
contract SqueekHatchery is ERC721Enumerable, Ownable2Step, Initializable, UUPSUpgradeable, ReentrancyGuard {
    uint256 public constant MAX_SVG_BYTES = 16_000;
    uint256 public constant MAX_TRAITS_BYTES = 1_500;
    uint256 public constant MAX_NAME_BYTES = 30;
    uint256 public constant ART_VERSION = 3;

    struct Companion {
        string name;
        string svg;
        string traits;
        uint16[3] growth;
        uint8 accessoryId;
        uint8 accessoryVersion;
    }
    uint256 public supplyCap;
    IHatchVerifier public verifier;
    mapping(address => bool) public hasClaimed;
    mapping(uint256 => bool) public isHatched;
    mapping(uint256 => Companion) private companions;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    error InvalidInput();
    error AlreadyClaimed();
    error SupplyExhausted();
    error AlreadyHatched();
    error NotTokenOwner();
    error VerifierUnset();
    error InvalidProof();
    event EggClaimed(uint256 indexed tokenId, address indexed owner, bytes32 seed);
    event Hatched(uint256 indexed tokenId, address indexed owner, bytes32 resultHash, uint256 nonce);
    event VerifierConfigured(address indexed previousVerifier, address indexed newVerifier);

    constructor() ERC721("Squeek Hatchery", "HATCH") Ownable(msg.sender) { _disableInitializers(); }

    /// Called atomically by ERC1967Proxy's constructor. No default admin or cap.
    function initialize(address admin, uint256 cap) external initializer {
        if (admin == address(0) || cap == 0) revert InvalidInput();
        _transferOwnership(admin);
        supplyCap = cap;
    }
    function name() public pure override returns (string memory) { return "Squeek Hatchery"; }
    function symbol() public pure override returns (string memory) { return "HATCH"; }
    function schemaVersion() public pure returns (uint256) { return ART_VERSION; }
    function seedOf(uint256 id) public view returns (bytes32) {
        _requireOwned(id);
        return keccak256(abi.encode(block.chainid, address(this), id));
    }
    function claim() external nonReentrant returns (uint256 id) {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        if (totalSupply() >= supplyCap) revert SupplyExhausted();
        hasClaimed[msg.sender] = true;
        id = totalSupply() + 1;
        _safeMint(msg.sender, id);
        emit EggClaimed(id, msg.sender, seedOf(id));
    }
    function setVerifier(address next) external onlyOwner {
        if (next != address(0) && next.code.length == 0) revert InvalidInput();
        emit VerifierConfigured(address(verifier), next);
        verifier = IHatchVerifier(next);
    }
    function hashResult(Companion calldata result) public pure returns (bytes32) { return keccak256(abi.encode(result)); }

    function hatch(uint256 id, Companion calldata result, HatchResult calldata proof, bytes calldata signature) external nonReentrant {
        if (ownerOf(id) != msg.sender) revert NotTokenOwner(); // operators cannot hatch
        if (isHatched[id]) revert AlreadyHatched();
        if (address(verifier) == address(0)) revert VerifierUnset();
        _checkResult(result);
        if (proof.chainId != block.chainid || proof.proxy != address(this) || proof.tokenId != id || proof.owner != msg.sender
            || proof.resultHash != hashResult(result) || proof.expiry < block.timestamp || usedNonces[msg.sender][proof.nonce]
            || signature.length == 0 || signature.length > 4096) revert InvalidProof();
        // Effects and the verifier decision are atomic: a false/reverting verifier rolls all back.
        usedNonces[msg.sender][proof.nonce] = true;
        if (!verifier.verify(proof, signature)) revert InvalidProof();
        isHatched[id] = true;
        companions[id] = result;
        emit Hatched(id, msg.sender, proof.resultHash, proof.nonce);
    }
    function companion(uint256 id) external view returns (Companion memory) { _requireOwned(id); return companions[id]; }
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        bytes memory json;
        if (!isHatched[id]) {
            json = abi.encodePacked('{"name":"Squeek Egg #', _decimal(id), '","description":"An unhatched Squeek Hatchery test egg. Owner hatching requires a configured verifier.","image":"data:image/svg+xml;base64,', Base64.encode(bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 420"><rect width="400" height="420" fill="#fbf3e6"/><ellipse cx="200" cy="215" rx="118" ry="152" fill="#f4dcc6" stroke="#b08d72" stroke-width="3"/></svg>')), '","attributes":[{"trait_type":"Stage","value":"Egg"}]}');
        } else {
            Companion storage c = companions[id];
            json = abi.encodePacked('{"name":"', c.name, '","description":"', description(), '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(c.svg)), '","attributes":', c.traits, '}');
        }
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }
    function description() public pure returns (string memory) { return "A Squeek Hatchery test companion. Session attestation depends on the configured verifier; signatures alone do not prove play. The admin can upgrade the rules."; }
    function _checkResult(Companion calldata c) private pure {
        bytes memory n = bytes(c.name);
        if (n.length == 0 || n.length > MAX_NAME_BYTES || n[0] == " " || n[n.length-1] == " ") revert InvalidInput();
        for (uint256 i; i < n.length; ++i) {
            bytes1 b = n[i];
            if (!((b >= "A" && b <= "Z") || (b >= "a" && b <= "z") || (b >= "0" && b <= "9") || b == " " || b == "." || b == "," || b == "'" || b == "-")) revert InvalidInput();
        }
        bytes memory s = bytes(c.svg); bytes memory t = bytes(c.traits);
        if (s.length < 64 || s.length > MAX_SVG_BYTES || s[0] != "<" || s[1] != "s" || s[2] != "v" || s[3] != "g" || s[4] != " "
            || t.length < 2 || t.length > MAX_TRAITS_BYTES || t[0] != "[" || t[t.length-1] != "]" || c.accessoryId > 11 || c.accessoryVersion != 1) revert InvalidInput();
        for (uint256 i; i < 3; ++i) if (c.growth[i] > 10_000) revert InvalidInput();
    }
    function _decimal(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len; while (n > 0) { ++len; n /= 10; }
        bytes memory out = new bytes(len); while (v > 0) { out[--len] = bytes1(uint8(48 + v % 10)); v /= 10; } return string(out);
    }
    function _authorizeUpgrade(address) internal override onlyOwner {}
    // Explicit reserve for future append-only test upgrades.
    uint256[40] private __gap;
}
