// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC721URIStorage, ERC721} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
/// @notice Testnet collectibles. Caller-supplied artwork is not proof of a genuine incubation.
contract SqueekHatchery is ERC721URIStorage {
    uint256 public nextTokenId;
    mapping(address => mapping(bytes32 => bool)) public mintedSessions;
    constructor() ERC721("Squeek Hatchery", "HATCH") {}
    function mint(string calldata uri, bytes32 sessionId) external returns(uint256 id) {
        require(bytes(uri).length > 0 && bytes(uri).length <= 30000, "Invalid metadata size");
        require(!mintedSessions[msg.sender][sessionId], "Session already minted");
        mintedSessions[msg.sender][sessionId] = true;
        id = nextTokenId++;
        _setTokenURI(id, uri);
        _safeMint(msg.sender, id);
    }
}
