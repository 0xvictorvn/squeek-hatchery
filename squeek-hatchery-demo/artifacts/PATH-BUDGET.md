# Explicit ignore-file path budget

The repository's preexisting local exclusion hides `artifacts/`. `.gitignore` now has a narrow, higher-priority allowlist so required contract artifacts and documentation enter the submission. No `.git/` file or existing exclusion was edited.

The aggregate uncompressed budget for the **exact paths below is 786,432 bytes (768 KiB)**, within the assignment's total 8,388,608-byte ceiling. All other `artifacts/` files remain ignored. No dependency, package archive, registry mirror, cache, node_modules or submodule is permitted by this change.

- `artifacts/PATH-BUDGET.md`
- `artifacts/DEPLOYMENT.md`
- `artifacts/PROOF-PROTOCOL.md`
- `artifacts/validation.md`
- `artifacts/DESIGN-GUIDANCE-LICENSE.txt`
- `artifacts/OPENZEPPELIN-LICENSE.txt`
- `artifacts/WALLET-ICONS-LICENSE.txt`
- `artifacts/contracts/SqueekHatchery.json`
- `artifacts/contracts/ERC1967Proxy.json`
- `artifacts/contracts/IHatchVerifier.json`
- `artifacts/contracts/MockHatchVerifier.json`
- `artifacts/contracts/HatcheryV2.json`
- `artifacts/contracts/ReceiverProbe.json`
- `artifacts/contracts/compiler.json`
- `artifacts/contracts/standard-input.json`

The compiler input contains the exact Solidity sources needed for source verification; bytecode/ABI/storage-layout records support local tests and upgrade review. Test mocks are labeled and are never configured in the public site. Licenses accompany the redistributed sources/marks/design guidance. Validation documentation records actual worker checks and their limits. These are required deliverables rather than dependency packaging. The static export and all frontend source remain separately complete.

Run `node scripts/check-delivery.mjs` to check both this path budget and the total work-file ceiling. The final measured values are recorded in `validation.md`; filesystem directory-entry overhead is not part of the file-byte budget.
