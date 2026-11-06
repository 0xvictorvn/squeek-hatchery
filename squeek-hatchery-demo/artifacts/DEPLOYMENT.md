# Sepolia test-source deployment and verification record

**No public deployment is part of this assignment.** The delivered proxy address, deployment block and proof-service URL are null. No supply quantity, admin address, deployment transaction or public verification is invented. The existing hosted name remains `squeek-hatchery-hatch-a-hamster.identitymd.eth`; `dist/` is the static delivery, with no publishing command run here.

## Compiler and artifacts

| Setting | Actual value |
| --- | --- |
| Compiler | 0.8.30+commit.73712a01 |
| Optimizer | Enabled, 200 runs |
| EVM | Prague |
| viaIR | false |
| OpenZeppelin | 5.4.0, existing lockfile |
| Target chain ID | 11155111 |
| Implementation | `contracts/SqueekHatchery.sol:SqueekHatchery` |
| Proxy | OpenZeppelin `ERC1967Proxy` |
| Public RPC default | `https://ethereum-sepolia-rpc.publicnode.com` |
| Proxy / start block / real verifier / proof service | Not configured |

`contracts/standard-input.json` contains all exact compiler input sources/settings, including OpenZeppelin dependencies. `contracts/SqueekHatchery.json` contains the full proxy-facing implementation ABI, creation/runtime bytecode and storage layout. Equivalent records exist for `ERC1967Proxy` and the **test-only** mock/verifier/callback/upgrade fixtures. `contracts/compiler.json` records compiler details. `src/abi.ts` is generated from the same implementation ABI.

The implementation uses the existing non-upgradeable OpenZeppelin package because dependencies are protected. Its constructors run only on the implementation: proxy name/symbol are constant overrides, admin is explicitly set by `initialize`, and the default-zero ReentrancyGuard state safely transitions to entered/not-entered. Initializable uses its namespaced OZ slot; UUPS uses ERC1967. Do not replace/reorder these bases or silently migrate to a different OpenZeppelin major/package. The exact storage layout is part of the upgrade contract.

## Atomic initialization, for an explicitly authorized future test deployment

1. Select the actual admin and positive supply cap explicitly. The admin is the requester's chosen account/multisig, not IdentityMD or an inferred deployer. The deployment constructor cannot supply defaults for either.
2. Deploy the locked implementation. Its constructor calls `_disableInitializers()`.
3. Construct initialization calldata with `abi.encodeCall(SqueekHatchery.initialize, (admin, cap))`.
4. Deploy **ERC1967Proxy(implementation, initializationCalldata)** in one transaction. Never create an uninitialized proxy and initialize it later. Confirm `owner`, `supplyCap`, `schemaVersion` and proxy implementation slot immediately.
5. Keep the verifier unset until a real, audited session validator exists. Only the admin can configure a verifier; every change emits `VerifierConfigured`. Setting it to zero deliberately disables hatch.
6. Verify the implementation and proxy using the delivered standard JSON input, exact compiler/settings and actual constructor arguments. Proxy constructor arguments are `abi.encode(implementation, initializationCalldata)`. Link the verified proxy to the actual implementation in the explorer; retain deployment receipts and the actual start block.
7. Only for a separately authorized integration, configure the proxy and real proof-service URL in the runtime JSON. Public config in this delivery stays null. The local test harness demonstrates this without changing/rebuilding the bundle.

There is no public deployment script that chooses an admin/cap or obtains a signer. Tests fetch unlocked accounts from their own loopback Anvil process; none is a production configuration value.

## Rules enforced in the current source

- ERC721Enumerable; token IDs start at 1. Positive supply cap set only during initialization; `claim()` checks it before minting.
- Free, nonpayable claim once per caller address. Claim state is set before `_safeMint`; transfers do not reset it. There is no Sybil/personhood guarantee.
- Predictable seed `keccak256(abi.encode(chainId, proxy, tokenId))`, never represented as randomness.
- `hatch()` requires the current owner as `msg.sender`; approval/operator rights do not permit hatch. It changes the existing token's metadata and never mints another ID.
- One hatch per token. Nonces are consumed once per owner within this proxy, atomically with verifier acceptance. The proof binds chain/proxy/token/owner/result hash/nonce/expiry. There is no unsigned overload or public bypass.
- ASCII name 1–30 bytes, no leading/trailing spaces; SVG 64–16,000 bytes and `<svg ` prefix; attributes 2–1,500 bytes with array framing; growth 0–10,000 per region; accessory ID 0–11 and version exactly 1; signature 1–4,096 bytes. The future verifier must additionally validate actual SVG/JSON semantics and the session/result relationship.
- Claim/hatch are nonreentrant. A rejecting ERC721 receiver rolls back supply and claim state. Verifier calls are `view`/static; false or revert rolls back nonce consumption.
- UUPS `_authorizeUpgrade` is owner-only and proxy-only upgrade calls are enforced by OZ. Admin transfer uses `transferOwnership` then `acceptOwnership`; the pending admin cannot upgrade before accepting.

## Upgrade and trust risks

The admin can replace the verifier or upgrade all rules, including cap/claim/hatch/metadata behavior. Frozen results are frozen by this implementation/UI, **not guaranteed against a future admin upgrade**. There is no timelock. Ownable's inherited renunciation can permanently remove the current administrative upgrade path; evaluate it before any deployment.

A future upgrade must retain the inheritance order, slot/type/member order, ownership and nonce mappings, enumerable token state, and existing companion strings/fields. Append new state after the current layout or consume reserved gap slots with a reviewed migration. The local `HatcheryV2` fixture only adds a version-returning function: tests compare slot/offset/type/label and check actual owner, cap, verifier, claims, token ownership/enumeration, seeds, hatch flags, consumed nonce and metadata after upgrade. This is evidence for that fixture, not an audit of arbitrary upgrades.

Local measurements and limitations are in `../VALIDATION.md`. Current implementation runtime size is 14,550 bytes; the cap-payload hatch remains below 16,777,216 gas in the local test. Chain deployment/verification, production proof validation, wallet-app behavior and arbitrary future upgrades remain unperformed.

Reference: [OpenZeppelin proxy/UUPS documentation](https://docs.openzeppelin.com/contracts/5.x/api/proxy), [two-step ownership](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step). Exact behavior here is pinned to the delivered 5.4.0 sources.
