# Hatch proof-provider integration

This is an **anti-forgery scaffold, with no production backend**. `IHatchVerifier` is the integration boundary. The public configuration has a null contract and a null proof-service URL; onchain verifier defaults to unset. There is no unsigned hatch route. A signature alone does not establish valid gameplay or genuine hardware.

## Exact encoded payload

`SqueekHatchery.hatch(tokenId, result, proof, signature)` takes:

```solidity
struct Companion {
    string name;
    string svg;
    string traits;
    uint16[3] growth;
    uint8 accessoryId;
    uint8 accessoryVersion;
}
struct HatchResult {
    uint256 chainId;
    address proxy;
    uint256 tokenId;
    address owner;
    bytes32 resultHash;
    uint256 nonce;
    uint256 expiry;
}
```

`resultHash = keccak256(abi.encode(result))`. The tuple's field order and widths matter; this is neither packed encoding nor a JSON hash. Growth is a 0–10,000 integer per region, rounded from the canonical session. Accessories use IDs 0–11 in the README's order, version 1. SVG/trait strings are the exact canonical export strings, independent of the Show coat view toggle. See `src/nft.ts` for shared TypeScript tuple definitions/hashes and `src/metadata.ts` for token/download JSON parity.

The contract independently checks `chainId == block.chainid`, `proxy == address(this)`, token ID, `owner == msg.sender == ownerOf(tokenId)`, exact result hash, unused owner nonce, expiry not earlier than `block.timestamp`, and all input bounds. Expiry is Unix seconds. A used nonce is scoped to owner + proxy storage; chain/proxy are also in the signed payload. The nonce is marked consumed before the verifier's static call; false/revert rolls the whole transaction back. There is no consume-on-failure or public bypass.

## HTTP boundary

After NFT incubation/review and fresh ownership/chain checks, the frontend sends JSON with `Content-Type: application/json` to the configured `proofServiceUrl`:

```ts
interface ProofRequest {
  protocol: 'squeek-hatch-v3';
  chainId: 11155111;
  proxy: string;
  tokenId: string; // decimal uint256
  owner: string;
  resultHash: string; // bytes32 hex
  result: Companion;
  session: Session; // v3 local candidate, NOT trusted evidence by itself
}
interface ProofResponse {
  proof: {
    chainId: string;
    proxy: string;
    tokenId: string;
    owner: string;
    resultHash: string;
    nonce: string; // fresh decimal uint256 allocated by the service
    expiry: string; // decimal Unix seconds
  };
  signature: string; // hex bytes accepted by the configured verifier
}
```

The endpoint must support the static site's CORS origin and POST preflight. Browser fetch uses a 15-second timeout, sends no private key and uses no signature during wallet connection. A failed HTTP response is surfaced with its status. A malformed binding, expired proof, already-used nonce, wrong owner/chain, signature rejection, simulation revert or transaction revert cannot create a success state. Ownership is checked before requesting proof and again before submission. Pending results stay frozen while a receipt is awaited; success requires the expected proxy event in a successful receipt.

The scaffold's request intentionally supplies **no secure session credential**. An implementation must establish an independently validated session before issuing an attestation; inventing an identifier or accepting this JSON as truth would defeat the design. Add an authenticated session/hardware protocol through a reviewed frontend/service integration when that system exists. No such service is claimed in this delivery.

## Responsibilities of a future real service/verifier

The service must independently establish hardware provenance/freshness and valid active play, handle visibility/session continuity with a defensible threat model, bind lamp inputs/timing to an authenticated session, compute and verify the exact v3 renderer/traits/accessory lock, query current proxy/token ownership, enforce duration/input limits, and refuse replayed/expired sessions. It must allocate nonces without reuse, set short expiries, protect signing keys, rate-limit, handle ownership transfers, and validate SVG/JSON semantics. Do not trust client wall time, localStorage, `elapsed`, posted growth or a browser-provided “hardware” label as evidence. Those are editable client inputs.

The production verifier must authenticate the complete `HatchResult` under the intended signer/key-management scheme and return true only for a valid signature. It must not be an always-true adapter, a client-supplied signer, or the test mock. Signer rotation, revocation, compromise recovery and any replay domain changes need explicit review. The proxy's current admin can replace the verifier and upgrade the rules, so trust remains in that administrator and attestation service.

## TEST-ONLY reference signing scheme

`contracts/test/MockHatchVerifier.sol` accepts an immutable **fixture signer**, recovering an ECDSA signature over:

```text
messageHash = keccak256(abi.encode(HatchResult))
signedDigest = EIP191 Ethereum Signed Message prefix for 32 bytes + messageHash
```

The local harness calls the disposable Anvil signer's `signMessage({message:{raw:hashProof(proof)}})`. The browser never receives a key. This exercises cryptographic result binding and negative/replay tests; the mock does **not** validate play/hardware and is never in the public config. The verifier interface allows a future signature scheme as long as the real provider/verifier agree and every payload field remains authenticated.

`tests/contract.chain.ts` checks wrong signer, chain, proxy, token, owner, result hash, expired/empty proof, nonce reuse and failed-verifier rollback. `tests/e2e.mjs` supplies a loopback-only mock endpoint, demonstrates a rejected proof then retry, and compares confirmed tokenURI to downloaded SVG/JSON byte content. Its runtime configuration responses demonstrate integration without changing the production bundle.
