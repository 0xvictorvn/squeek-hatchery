import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { buildTraits } from "./metadata.ts";
import { portraitSVG } from "./art.ts";
import type { Session } from "./rules.ts";
export { HATCHERY_ABI } from "./abi.ts";
export const RESULT_TYPE = parseAbiParameters(
  "(string name, string svg, string traits, uint16[3] growth, uint8 accessoryId, uint8 accessoryVersion)",
);
export const PROOF_TYPE = parseAbiParameters(
  "(uint256 chainId, address proxy, uint256 tokenId, address owner, bytes32 resultHash, uint256 nonce, uint256 expiry)",
);
export interface Companion {
  name: string;
  svg: string;
  traits: string;
  growth: readonly [number, number, number];
  accessoryId: number;
  accessoryVersion: number;
}
export interface HatchProof {
  chainId: bigint;
  proxy: Address;
  tokenId: bigint;
  owner: Address;
  resultHash: Hex;
  nonce: bigint;
  expiry: bigint;
}
export function companionOf(s: Session, name: string): Companion {
  return {
    name,
    svg: portraitSVG(s),
    traits: buildTraits(s),
    growth: s.regions.map((r) => Math.round(r.growth * 10000)) as [
      number,
      number,
      number,
    ],
    accessoryId: s.accessoryId,
    accessoryVersion: s.accessoryVersion,
  };
}
export const hashResult = (c: Companion) =>
  keccak256(encodeAbiParameters(RESULT_TYPE, [c]));
export const hashProof = (p: HatchProof) =>
  keccak256(encodeAbiParameters(PROOF_TYPE, [p]));
