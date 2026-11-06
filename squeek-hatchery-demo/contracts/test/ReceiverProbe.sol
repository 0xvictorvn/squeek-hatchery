// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SqueekHatchery} from "../SqueekHatchery.sol";
import {HatchResult} from "../IHatchVerifier.sol";
/// Test callback probe. Nested claim/hatch attempts must fail, or rejecting receiver rolls back.
contract ReceiverProbe is IERC721Receiver {
 SqueekHatchery public target; bool public nestedClaimSucceeded; bool public nestedHatchSucceeded; bool public reject;
 function run(address t,bool shouldReject) external { target=SqueekHatchery(t);reject=shouldReject;target.claim(); }
 function onERC721Received(address,address,uint256 id,bytes calldata) external returns(bytes4){
  try target.claim(){nestedClaimSucceeded=true;}catch{}
  SqueekHatchery.Companion memory c;HatchResult memory p;
  try target.hatch(id,c,p,hex"01"){nestedHatchSucceeded=true;}catch{}
  if(reject)revert("receiver rejected");return IERC721Receiver.onERC721Received.selector;
 }
}
