import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  zeroAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { startChain, artifact } from "./anvil.ts";
import {
  freshSession,
  palette,
  develop,
  lockAccessory,
  validateStatus,
} from "../src/rules.ts";
import {
  companionOf,
  hashResult,
  hashProof,
  type HatchProof,
  type Companion,
} from "../src/nft.ts";
import { metadataJSON } from "../src/metadata.ts";

test("local proxy: claim, owner hatch, signed proof binding, callback safety and upgrade retention", async () => {
  const c = await startChain();
  let passes = 0;
  try {
    const [deployer, admin, alice, bob, operator, signer, other, carol, dave] =
      c.accounts;
    const read = (fn: string, args: unknown[] = [], address = c.address) =>
      c.pub.readContract({ address, abi: c.abi, functionName: fn, args });
    const write = async (
      account: Address,
      fn: string,
      args: unknown[] = [],
      address = c.address,
      abi = c.abi,
    ) => {
      const hash = await c
        .wallet(account)
        .writeContract({
          address,
          abi,
          functionName: fn,
          args,
          gas: 16_000_000n,
        });
      const receipt = await c.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Reverted " + fn);
      return receipt;
    };
    const refuses = async (
      account: Address,
      fn: string,
      args: unknown[] = [],
      address = c.address,
    ) => {
      await assert.rejects(() =>
        c.pub.simulateContract({
          account,
          address,
          abi: c.abi,
          functionName: fn,
          args,
        }),
      );
      passes++;
    };
    assert.equal(await read("owner"), admin);
    assert.equal(await read("supplyCap"), 8n);
    assert.equal(await read("totalSupply"), 0n);
    await refuses(alice, "initialize", [alice, 100n]);
    await refuses(alice, "initialize", [alice, 100n], c.implementation);
    await assert.rejects(() =>
      c.deploy("ERC1967Proxy", [
        c.implementation,
        encodeFunctionData({
          abi: c.abi,
          functionName: "initialize",
          args: [zeroAddress, 1n],
        }),
      ]),
    );
    await assert.rejects(() =>
      c.deploy("ERC1967Proxy", [
        c.implementation,
        encodeFunctionData({
          abi: c.abi,
          functionName: "initialize",
          args: [admin, 0n],
        }),
      ]),
    );
    const claim = await write(alice, "claim");
    assert.ok(claim.gasUsed < 500000n);
    assert.equal(await read("ownerOf", [1n]), alice);
    assert.equal(await read("hasClaimed", [alice]), true);
    await refuses(alice, "claim");
    await write(alice, "transferFrom", [alice, bob, 1n]);
    assert.equal(await read("hasClaimed", [alice]), true);
    await refuses(alice, "claim");
    await write(bob, "claim");
    assert.equal(await read("balanceOf", [bob]), 2n);
    const s = freshSession("chain-parity");
    lockAccessory(
      s,
      validateStatus({
        schemaVersion: 1,
        measurement: {
          freshness: "online",
          provenance: "hardware",
          coreStatus: "ACTIVE",
          rpmMilli: 120000,
          distanceMm: 250000,
          cumulativeWorkUnits: "2000",
          counterEpoch: "test",
          observedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          staleAfterSeconds: 15,
        },
      }),
    );
    for (const p of [-70, 0, 70]) {
      s.lampPosition = p;
      develop(s, 20, 120, palette(p === 0 ? 250000 : 500000, "2026-11-02"));
    }
    s.endedAt = "2026-11-02T00:00:00Z";
    const result = companionOf(s, "Test Pip");
    const proof = (
      id = 1n,
      owner = bob,
      nonce = 1n,
      r = result,
    ): HatchProof => ({
      chainId: 11155111n,
      proxy: c.address,
      tokenId: id,
      owner,
      resultHash: hashResult(r),
      nonce,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const sign = (p: HatchProof, who = signer) =>
      c.wallet(who).signMessage({ message: { raw: hashProof(p) } });
    const p = proof(),
      signature = await sign(p);
    await refuses(bob, "hatch", [1n, result, p, signature]); // unset verifier
    const verifier = await c.deploy("MockHatchVerifier", [signer]);
    await refuses(bob, "setVerifier", [verifier]);
    await refuses(deployer, "setVerifier", [verifier]);
    await refuses(admin, "setVerifier", [alice]);
    const set = await write(admin, "setVerifier", [verifier]);
    assert.ok(set.logs.length > 0);
    await write(bob, "approve", [operator, 1n]);
    await refuses(operator, "hatch", [1n, result, p, signature]);
    await refuses(alice, "hatch", [1n, result, p, signature]);
    for (const patch of [
      { chainId: 1n },
      { proxy: verifier },
      { tokenId: 2n },
      { owner: alice },
      { resultHash: hashResult({ ...result, name: "Changed" }) },
      { expiry: 1n },
    ]) {
      const wrong = { ...p, ...patch };
      await refuses(bob, "hatch", [1n, result, wrong, await sign(wrong)]);
      assert.equal(await read("usedNonces", [bob, p.nonce]), false);
    }
    await refuses(bob, "hatch", [1n, result, p, await sign(p, other)]);
    await refuses(bob, "hatch", [1n, result, p, "0x"]);
    for (const patch of [
      { name: "" },
      { name: " invalid" },
      { name: "A".repeat(31) },
      { name: "<svg>" },
      { svg: "<svg />" },
      { svg: "x".repeat(16001) },
      { traits: "{}" },
      { traits: "[" + " ".repeat(1500) + "]" },
      { growth: [10001, 0, 0] },
      { accessoryId: 12 },
      { accessoryVersion: 0 },
    ]) {
      const invalid = { ...result, ...patch } as Companion,
        pr = proof(1n, bob, 2n, invalid);
      await refuses(bob, "hatch", [1n, invalid, pr, await sign(pr)]);
    }
    assert.equal(await read("usedNonces", [bob, 1n]), false);
    const hatch = await write(bob, "hatch", [1n, result, p, signature]);
    assert.equal(await read("isHatched", [1n]), true);
    assert.equal(await read("ownerOf", [1n]), bob);
    assert.equal(await read("totalSupply"), 2n);
    assert.equal(await read("usedNonces", [bob, 1n]), true);
    assert.ok(hatch.gasUsed < 16_777_216n);
    console.log(
      "Local claim gas",
      claim.gasUsed.toString(),
      "hatch gas",
      hatch.gasUsed.toString(),
      "SVG bytes",
      result.svg.length,
    );
    const uri = (await read("tokenURI", [1n])) as string;
    assert.deepEqual(
      JSON.parse(atob(uri.split(",")[1])),
      JSON.parse(metadataJSON(s, "Test Pip")),
    );
    await refuses(bob, "hatch", [1n, result, p, signature]);
    const reused = { ...p, tokenId: 2n };
    await refuses(bob, "hatch", [2n, result, reused, await sign(reused)]);
    await write(bob, "transferFrom", [bob, alice, 2n]);
    await refuses(bob, "hatch", [
      2n,
      result,
      proof(2n, bob, 3n),
      await sign(proof(2n, bob, 3n)),
    ]);
    await write(admin, "setVerifier", [zeroAddress]);
    const ap = proof(2n, alice, 4n);
    await refuses(alice, "hatch", [2n, result, ap, await sign(ap)]);
    await write(admin, "setVerifier", [verifier]);
    // Safe receiver: both nested calls are rejected by the reentrancy guard.
    const receiver = await c.deploy("ReceiverProbe");
    const recvAbi = artifact("ReceiverProbe").abi;
    const rr = await write(
      deployer,
      "run",
      [c.address, false],
      receiver,
      recvAbi,
    );
    assert.ok(rr.gasUsed > 0n);
    for (const fn of ["nestedClaimSucceeded", "nestedHatchSucceeded"])
      assert.equal(
        await c.pub.readContract({
          address: receiver,
          abi: recvAbi,
          functionName: fn,
        }),
        false,
      );
    const rejecting = await c.deploy("ReceiverProbe");
    await assert.rejects(() =>
      c.pub.simulateContract({
        account: deployer,
        address: rejecting,
        abi: recvAbi,
        functionName: "run",
        args: [c.address, true],
      }),
    );
    assert.equal(await read("hasClaimed", [rejecting]), false);
    assert.equal(await read("totalSupply"), 3n);
    // UUPS only through the proxy; only its configured owner can authorize an upgrade.
    const next = await c.deploy("HatcheryV2");
    await refuses(alice, "upgradeToAndCall", [next, "0x"]);
    await refuses(deployer, "upgradeToAndCall", [next, "0x"]);
    await refuses(admin, "upgradeToAndCall", [next, "0x"], c.implementation);
    await refuses(admin, "upgradeToAndCall", [verifier, "0x"]);
    await refuses(alice, "transferOwnership", [alice]);
    await write(admin, "transferOwnership", [carol]);
    assert.equal(await read("owner"), admin);
    assert.equal(await read("pendingOwner"), carol);
    await refuses(bob, "acceptOwnership");
    await refuses(carol, "upgradeToAndCall", [next, "0x"]);
    await write(carol, "acceptOwnership");
    await refuses(admin, "upgradeToAndCall", [next, "0x"]);
    const before = await read("companion", [1n]),
      seed = await read("seedOf", [1n]);
    await write(carol, "upgradeToAndCall", [next, "0x"]);
    assert.equal(
      await c.pub.readContract({
        address: c.address,
        abi: artifact("HatcheryV2").abi,
        functionName: "upgradeTestVersion",
      }),
      2n,
    );
    assert.deepEqual(await read("companion", [1n]), before);
    assert.equal(await read("owner"), carol);
    assert.equal(await read("supplyCap"), 8n);
    assert.equal(await read("totalSupply"), 3n);
    assert.equal(await read("verifier"), verifier);
    assert.equal(await read("hasClaimed", [alice]), true);
    assert.equal(await read("ownerOf", [1n]), bob);
    assert.equal(await read("isHatched", [1n]), true);
    assert.equal(await read("usedNonces", [bob, 1n]), true);
    assert.equal(await read("seedOf", [1n]), seed);
    assert.equal(await read("balanceOf", [bob]), 1n);
    assert.equal(await read("tokenOfOwnerByIndex", [bob, 0n]), 1n);
    await refuses(carol, "initialize", [carol, 90n]);
    // Maximum accepted payload remains below Sepolia's transaction gas cap.
    const svgPrefix = '<svg xmlns="http://www.w3.org/2000/svg"><!--',
      svgSuffix = "--></svg>";
    const maximum = {
      ...result,
      name: "W".repeat(30),
      svg:
        svgPrefix +
        " ".repeat(16000 - svgPrefix.length - svgSuffix.length) +
        svgSuffix,
      traits: "[" + " ".repeat(1498) + "]",
      growth: [10000, 10000, 10000] as const,
      accessoryId: 11,
    };
    const maxProof = proof(2n, alice, 50n, maximum);
    const maxReceipt = await write(alice, "hatch", [
      2n,
      maximum,
      maxProof,
      await sign(maxProof),
    ]);
    assert.ok(maxReceipt.gasUsed < 16_777_216n);
    console.log("At-cap hatch gas", maxReceipt.gasUsed.toString());
    for (const a of [operator, signer, other, carol, dave])
      await write(a, "claim");
    assert.equal(await read("totalSupply"), 8n);
    await refuses(c.accounts[9], "claim");
    console.log(
      "Negative contract checks:",
      passes,
      "plus atomic proxy initialization and callback rollback",
    );
    // Layout retention: every original storage entry retains label/slot/offset/type.
    const old = artifact("SqueekHatchery").storageLayout.storage,
      nextLayout = artifact("HatcheryV2").storageLayout.storage;
    const shape = (entries: typeof old) =>
      entries.map(
        ({
          label,
          slot,
          offset,
          type,
        }: {
          label: string;
          slot: string;
          offset: number;
          type: string;
        }) => ({ label, slot, offset, type }),
      );
    assert.deepEqual(shape(old), shape(nextLayout));
  } finally {
    c.stop();
  }
});
