// Read-only checks for the requested static/source submission, not a behavior certification.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Change discovery. Preferred: Git. Fallback for plain working-copy folders (no Git on PATH or no
// repository): compare against a SHA-256 baseline manifest. Nothing is initialized or modified.
//   Baseline lookup: DELIVERY_BASELINE env var, else ../work/antigravity-review/baseline.json.
// Manifest shape: { files: { "<path relative to this project>": { sha256 } } }.
let changeSource = "git";
let baselineInfo = null;
let allChanged;
let added;
const gitList = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0")
    .filter(Boolean);
function walkProject(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "cache", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkProject(p, out);
    else out.push(p.split(path.sep).join("/").replace(/^\.\//, ""));
  }
  return out;
}
try {
  allChanged = gitList(["diff", "--name-only", "-z"]);
  added = gitList(["ls-files", "--others", "--exclude-standard", "-z"]);
} catch (gitError) {
  const baselinePath = path.resolve(
    process.env.DELIVERY_BASELINE ?? path.join("..", "work", "antigravity-review", "baseline.json"),
  );
  if (!fs.existsSync(baselinePath)) {
    console.error(
      `Git is unavailable or this is not a Git repository (${gitError.code ?? gitError.message}), ` +
        `and no baseline manifest was found at ${baselinePath}. ` +
        "Set DELIVERY_BASELINE=<manifest.json> or run inside a Git checkout.",
    );
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  allChanged = [];
  added = [];
  for (const f of walkProject(".")) {
    const entry = manifest.files?.[f];
    if (!entry) added.push(f);
    else if (entry.sha256 !== sha(f)) allChanged.push(f);
  }
  for (const f of Object.keys(manifest.files ?? {})) {
    if (!fs.existsSync(f)) allChanged.push(f); // deleted baseline file
  }
  changeSource = "baseline-manifest";
  baselineInfo = { path: baselinePath, entries: Object.keys(manifest.files ?? {}).length };
}
const changed = allChanged.filter((f) => fs.existsSync(f));
const files = [...new Set([...changed, ...added])].filter(
  (f) => !f.startsWith("test/scratch/") && !f.startsWith(".imd/"),
);const forbidden =
  /^(?:\.git\/|\.github\/|lib\/|foundry\.toml$|foundry\.lock$|remappings\.txt$|\.gitmodules$|package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$)|(?:^|\/)(?:node_modules|\.env(?:\..*)?)(?:\/|$)/;
assert.equal(
  [...allChanged, ...added].filter((f) => forbidden.test(f)).length,
  0,
  "Protected paths changed",
);
assert.equal(
  files.filter((f) => /\.tgz$|\.map$/.test(f)).length,
  0,
  "Unnecessary archive/source map in work files",
);
const artifactFiles = files.filter((f) => f.startsWith("artifacts/"));
const artifactBytes = artifactFiles.reduce(
  (n, f) => n + fs.statSync(f).size,
  0,
);
assert.ok(
  artifactBytes <= 786432,
  `Artifacts exceed the explicit 768 KiB path budget: ${artifactBytes}`,
);
const workBytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
assert.ok(workBytes <= 8388608, `Work files exceed 8 MiB: ${workBytes}`);
const html = fs.readFileSync("dist/index.html", "utf8");
for (const needed of [
  "<title>",
  'name="description"',
  'rel="icon"',
  'property="og:title"',
  'property="og:image"',
])
  assert.ok(html.includes(needed), needed);
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  assert.ok(url.startsWith("./"), `Nonrelative asset URL: ${url}`);
  assert.ok(fs.existsSync(path.join("dist", url)), `Missing ${url}`);
}
for (const name of ["favicon.svg", "og-image.png", "hatchery.config.json"])
  assert.deepEqual(
    fs.readFileSync("dist/" + name),
    fs.readFileSync("public/" + name),
  );
const config = JSON.parse(fs.readFileSync("dist/hatchery.config.json", "utf8"));
assert.equal(config.chainId, 11155111);
assert.equal(config.contractAddress, null);
assert.equal(config.startBlock, null);
assert.equal(config.proofServiceUrl, null);
const input = JSON.parse(
  fs.readFileSync("artifacts/contracts/standard-input.json", "utf8"),
);
for (const [file, source] of Object.entries(input.sources))
  if (file.startsWith("contracts/"))
    assert.equal(
      // Normalize CRLF/LF so a Windows working copy with converted line endings is compared by content.
      fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
      source.content.replace(/\r\n/g, "\n"),
      `Compiler input is stale: ${file}`,
    );
const contract = JSON.parse(
  fs.readFileSync("artifacts/contracts/SqueekHatchery.json", "utf8"),
);
const abiText = fs.readFileSync("src/abi.ts", "utf8");
const abi = JSON.parse(
  abiText.slice(abiText.indexOf("=") + 1, abiText.lastIndexOf(" as const")),
);
assert.deepEqual(abi, contract.abi, "Frontend ABI differs from compiler");
for (const name of [
  "initialize",
  "claim",
  "hatch",
  "upgradeToAndCall",
  "transferOwnership",
  "acceptOwnership",
])
  assert.ok(abi.some((x) => x.type === "function" && x.name === name));
assert.ok(
  !abi.some((x) => x.type === "function" && x.name === "mint"),
  "Old public mint route remains",
);
assert.ok(
  (contract.deployedBytecode.length - 2) / 2 <= 24576,
  "Implementation exceeds EIP-170",
);
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
const exportFiles = walk("dist");
const exportBytes = exportFiles.reduce((n, f) => n + fs.statSync(f).size, 0);
if (process.argv[2]) {
  const reference = path.resolve(process.argv[2]);
  assert.deepEqual(
    exportFiles.map((f) => path.relative("dist", f)).sort(),
    walk(reference)
      .map((f) => path.relative(reference, f))
      .sort(),
    "Export tree differs from production build",
  );
  for (const f of exportFiles)
    assert.deepEqual(
      fs.readFileSync(f),
      fs.readFileSync(path.join(reference, path.relative("dist", f))),
    );
}
console.log(
  JSON.stringify(
    {
      passed: true,
      changeSource,
      baseline: baselineInfo,
      workFiles: files.length,
      workBytes,
      artifactBytes,
      artifactBudget: 786432,
      limit: 8388608,
      exportFiles: exportFiles.length,
      exportBytes,
      implementationBytes: (contract.deployedBytecode.length - 2) / 2,
      relativeAssets: true,
      nullPublicConfig: true,
      abiAndCompilerSourcesMatch: true,
    },
    null,
    2,
  ),
);