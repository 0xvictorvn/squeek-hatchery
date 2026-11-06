// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SqueekHatchery} from "../SqueekHatchery.sol";
contract HatcheryV2 is SqueekHatchery { function upgradeTestVersion() external pure returns (uint256) { return 2; } }
