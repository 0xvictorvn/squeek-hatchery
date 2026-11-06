// Wallet reads and the Sepolia test claim/hatch flow. The local demo is independent.
import {
  connect,
  createConfig,
  disconnect,
  getConnection,
  getConnectors,
  http,
  injected,
  signMessage,
  simulateContract,
  switchChain,
  waitForTransactionReceipt,
  watchConnection,
  watchConnectors,
  writeContract,
  type Config,
  type Connector,
} from "@wagmi/core";
import { coinbaseWallet } from "@wagmi/connectors";
import { sepolia } from "viem/chains";
import {
  BaseError,
  decodeEventLog,
  isAddress,
  type Address,
  type Hash,
} from "viem";

import type { Session } from "./rules.ts";

export const SEPOLIA_ID = 11155111;
export const SITE_NAME = "Squeek Hatchery";

export interface RuntimeConfig {
  chainId: number;
  contractAddress: Address | null;
  startBlock: string | null;
  proofServiceUrl: string | null;
  rpcUrl: string;
  explorer: string;
}
const DEFAULTS: RuntimeConfig = {
  chainId: SEPOLIA_ID,
  contractAddress: null,
  startBlock: null,
  proofServiceUrl: null,
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
};

import {
  HATCHERY_ABI,
  hashResult,
  type Companion,
  type HatchProof,
} from "./nft.ts";
export { HATCHERY_ABI } from "./nft.ts";
import { createPublicClient, getAddress, zeroAddress, type Hex } from "viem";

export let runtime: RuntimeConfig = DEFAULTS;
export let config: Config;

/** Owner-settable: hatchery.config.json next to index.html holds the deployed address. No rebuild needed. */
export async function initWallet(): Promise<RuntimeConfig> {
  try {
    const r = await fetch("./hatchery.config.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const j = await r.json();
      const addr =
        typeof j.contractAddress === "string" &&
        isAddress(j.contractAddress) &&
        !/^0x0{40}$/i.test(j.contractAddress)
          ? (j.contractAddress as Address)
          : null;
      runtime = {
        chainId: SEPOLIA_ID, // the site only ever targets Sepolia
        contractAddress: j.chainId === SEPOLIA_ID ? addr : null,
        startBlock:
          typeof j.startBlock === "string" && /^\d+$/.test(j.startBlock)
            ? j.startBlock
            : null,
        proofServiceUrl:
          typeof j.proofServiceUrl === "string" &&
          (/^https:\/\//.test(j.proofServiceUrl) ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(j.proofServiceUrl))
            ? j.proofServiceUrl
            : null,
        rpcUrl:
          typeof j.rpcUrl === "string" && /^https?:\/\//.test(j.rpcUrl)
            ? j.rpcUrl
            : DEFAULTS.rpcUrl,
        explorer:
          typeof j.explorer === "string" && /^https:\/\//.test(j.explorer)
            ? j.explorer.replace(/\/$/, "")
            : DEFAULTS.explorer,
      };
    }
  } catch {
    /* keep defaults: minting stays unavailable without an address */
  }
  config = createConfig({
    chains: [sepolia],
    storage: null,
    multiInjectedProviderDiscovery: true, // EIP-6963: each installed extension by its own name
    connectors: [injected(), coinbaseWallet({ appName: SITE_NAME })],
    transports: { [sepolia.id]: http(runtime.rpcUrl) },
  });
  return runtime;
}

export async function signChallengeMessage(
  address: string,
  message: string,
): Promise<Hex> {
  const c = connection();
  if (c.address && c.address.toLowerCase() === address.toLowerCase()) {
    return signMessage(config, { message });
  }
  const eth = (
    window as unknown as {
      ethereum?: {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
    }
  ).ethereum;
  if (eth && typeof eth.request === "function") {
    const sig = await eth.request({
      method: "personal_sign",
      params: [message, address],
    });
    if (typeof sig === "string" && sig.startsWith("0x")) {
      return sig as Hex;
    }
  }
  throw new Error("Connect a wallet first to sign the challenge message.");
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const connection = () => getConnection(config);
export const onConnection = (fn: () => void) =>
  watchConnection(config, { onChange: fn });
export const onConnectors = (fn: () => void) =>
  watchConnectors(config, { onChange: fn });

/** Rows for the connect sheet, in the network's order. The generic injected row only when nothing was discovered. */
export function walletRows(): { connector: Connector; label: string }[] {
  const all = getConnectors(config);
  const named = all.some((c) => c.type === "injected" && c.id !== "injected");
  return [
    ...all.filter((c) => c.type === "injected"),
    ...all.filter((c) => c.type !== "injected"),
  ]
    .filter((c) => !(c.id === "injected" && named))
    .map((c) => ({
      connector: c,
      label:
        c.id === "injected"
          ? "Browser wallet"
          : c.id === "coinbaseWalletSDK" && isMobileBrowser()
            ? "Coinbase Smart Wallet"
            : c.name,
    }));
}

export const connectWith = (connector: Connector) =>
  connect(config, { connector, chainId: SEPOLIA_ID });
export const disconnectWallet = () => disconnect(config);
export const switchToSepolia = () =>
  switchChain(config, { chainId: SEPOLIA_ID });

export const OPEN_IN: ReadonlyArray<{
  id: string;
  name: string;
  href: (url: string) => string;
}> = [
  {
    id: "metamask",
    name: "MetaMask",
    href: (url) =>
      `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}`,
  },
  {
    id: "coinbase",
    name: "Coinbase Wallet",
    href: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`,
  },
  {
    id: "rabby",
    name: "Rabby",
    href: (url) =>
      `https://go.rabby.io/mobile/dapp?url=${encodeURIComponent(url)}`,
  },
  {
    id: "phantom",
    name: "Phantom",
    href: (url) =>
      `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  },
];
export const isMobileBrowser = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
  !(window as unknown as { ethereum?: unknown }).ethereum;

export const txUrl = (h: string) => `${runtime.explorer}/tx/${h}`;
export const tokenUrl = (id: string) =>
  `${runtime.explorer}/nft/${runtime.contractAddress}/${id}`;
export const publicClient = () =>
  createPublicClient({
    chain: sepolia,
    transport: http(runtime.rpcUrl, { timeout: 10000, retryCount: 0 }),
  });
let rpcCheckedAt = 0;
let rpcCheck: Promise<void> | null = null;
async function verifyRpc() {
  if (Date.now() - rpcCheckedAt < 30000) return;
  rpcCheck ||= publicClient()
    .getChainId()
    .then((id) => {
      if (id !== SEPOLIA_ID)
        throw new Error("Configured RPC is not Sepolia (11155111).");
      rpcCheckedAt = Date.now();
    })
    .finally(() => {
      rpcCheck = null;
    });
  await rpcCheck;
}
export const read = async (
  functionName: string,
  args: readonly unknown[] = [],
) => {
  if (!runtime.contractAddress) throw new Error("Contract not deployed");
  await verifyRpc();
  return publicClient().readContract({
    address: runtime.contractAddress,
    abi: HATCHERY_ABI,
    functionName,
    args,
  } as never) as Promise<unknown>;
};
export async function walletFacts() {
  const c = connection();
  if (!c.address) return null;
  const address = getAddress(c.address);
  await verifyRpc();
  const balance = await publicClient().getBalance({ address });
  return { address, network: c.chainId, balance };
}
export interface Holding {
  id: string;
  hatched: boolean;
  name: string;
  image: string;
  metadata: string;
}
export async function holdings(offset = 0n, limit = 24) {
  const c = connection();
  if (!c.address) throw new Error("Connect a wallet to read holdings");
  if ((await read("schemaVersion")) !== 3n)
    throw new Error("Incompatible contract schema");
  const count = (await read("balanceOf", [c.address])) as bigint;
  const end = count < offset + BigInt(limit) ? count : offset + BigInt(limit);
  const tokens = await Promise.all(
    Array.from(
      { length: Number(end - offset > 0n ? end - offset : 0n) },
      async (_, i) => {
        const id = (await read("tokenOfOwnerByIndex", [
          c.address,
          offset + BigInt(i),
        ])) as bigint;
        const [owner, hatched, uri] = await Promise.all([
          read("ownerOf", [id]),
          read("isHatched", [id]),
          read("tokenURI", [id]),
        ]);
        if (String(owner).toLowerCase() !== c.address!.toLowerCase())
          throw new Error("Ownership changed. Refresh holdings.");
        if (
          typeof uri !== "string" ||
          !uri.startsWith("data:application/json;base64,")
        )
          throw new Error("Unsupported NFT metadata");
        const metadata = atob(uri.split(",")[1]);
        const m = JSON.parse(metadata);
        const image =
          typeof m.image === "string" &&
          m.image.startsWith("data:image/svg+xml;base64,")
            ? m.image
            : "";
        return {
          id: String(id),
          hatched: !!hatched,
          name: String(m.name),
          image,
          metadata,
        };
      },
    ),
  );
  return { count, tokens, next: end };
}
export type TxEvent =
  | { kind: "checking" | "confirm" | "proof" }
  | { kind: "pending"; hash: Hash }
  | { kind: "success"; hash: Hash; tokenId: string };
export const errorMessage = (e: unknown) =>
  e instanceof BaseError
    ? /reject|denied/i.test(e.message)
      ? "You declined the wallet request. You can try again."
      : e.shortMessage
    : e instanceof Error
      ? e.message
      : "The request failed. Try again.";
function assertConnection(address: Address) {
  const c = connection();
  if (
    c.address?.toLowerCase() !== address.toLowerCase() ||
    c.chainId !== SEPOLIA_ID
  )
    throw new Error("Wallet changed. Select the egg again on Sepolia.");
}
export async function assertOwner(id: bigint, address: Address) {
  assertConnection(address);
  if (
    String(await read("ownerOf", [id])).toLowerCase() !== address.toLowerCase()
  )
    throw new Error("You no longer own this egg. Refresh My NFTs.");
  if (await read("isHatched", [id]))
    throw new Error("This egg has already hatched. Refresh My NFTs.");
  assertConnection(address);
}
export async function transact(
  kind: "claim" | "hatch",
  on: (e: TxEvent) => void,
  id?: bigint,
  result?: Companion,
  session?: Session,
) {
  const c = connection(),
    proxy = runtime.contractAddress;
  if (!proxy) throw new Error("Contract not deployed");
  if (!c.address || c.chainId !== SEPOLIA_ID)
    throw new Error("Connect a wallet on Sepolia first.");
  const account = c.address;
  on({ kind: "checking" });
  if ((await read("schemaVersion")) !== 3n)
    throw new Error("Incompatible contract schema");
  let send: () => Promise<Hash>;
  if (kind === "claim") {
    if (await read("hasClaimed", [account]))
      throw new Error(
        "This wallet has already claimed its egg. Transfers do not reset claims.",
      );
    assertConnection(account);
    const { request } = await simulateContract(config, {
      chainId: SEPOLIA_ID,
      address: proxy,
      abi: HATCHERY_ABI,
      functionName: "claim",
      account,
    });
    send = () => writeContract(config, request);
  } else {
    if (!id || !result || !session)
      throw new Error("Complete and review an NFT incubation first.");
    if (!runtime.proofServiceUrl)
      throw new Error("Hatch disabled: proof service not configured.");
    if (String(await read("verifier")).toLowerCase() === zeroAddress)
      throw new Error("Hatch disabled: verifier not configured.");
    await assertOwner(id, account);
    on({ kind: "proof" });
    const response = await fetch(runtime.proofServiceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "squeek-hatch-v3",
        chainId: SEPOLIA_ID,
        proxy,
        tokenId: id.toString(),
        owner: account,
        resultHash: hashResult(result),
        result,
        session,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        `Proof service refused this session (${response.status}).`,
      );
    const body = await response.json();
    const proof: HatchProof = {
      chainId: BigInt(body.proof.chainId),
      proxy: body.proof.proxy,
      tokenId: BigInt(body.proof.tokenId),
      owner: body.proof.owner,
      resultHash: body.proof.resultHash,
      nonce: BigInt(body.proof.nonce),
      expiry: BigInt(body.proof.expiry),
    };
    if (
      proof.chainId !== BigInt(SEPOLIA_ID) ||
      proof.proxy.toLowerCase() !== proxy.toLowerCase() ||
      proof.tokenId !== id ||
      proof.owner.toLowerCase() !== account.toLowerCase() ||
      proof.resultHash !== hashResult(result) ||
      proof.expiry < BigInt(Math.floor(Date.now() / 1000)) ||
      typeof body.signature !== "string" ||
      !/^0x[0-9a-f]+$/i.test(body.signature)
    )
      throw new Error("Proof service returned an invalid result binding.");
    if (await read("usedNonces", [account, proof.nonce]))
      throw new Error(
        "This proof nonce is already used. Request a new attestation.",
      );
    await assertOwner(id, account);
    const { request } = await simulateContract(config, {
      chainId: SEPOLIA_ID,
      address: proxy,
      abi: HATCHERY_ABI,
      functionName: "hatch",
      args: [id, result, proof, body.signature as Hex],
      account,
    });
    send = () => writeContract(config, request);
  }
  assertConnection(account);
  if (kind === "hatch") await assertOwner(id!, account);
  on({ kind: "confirm" });
  const hash = await send();
  on({ kind: "pending", hash });
  const receipt = await waitForTransactionReceipt(config, {
    chainId: SEPOLIA_ID,
    hash,
    timeout: 180000,
  });
  if (receipt.status !== "success")
    throw new Error("The transaction reverted. The result was not confirmed.");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== proxy.toLowerCase()) continue;
    try {
      const e = decodeEventLog({
        abi: HATCHERY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (
        (kind === "claim" && e.eventName === "EggClaimed") ||
        (kind === "hatch" && e.eventName === "Hatched")
      ) {
        on({ kind: "success", hash, tokenId: e.args.tokenId.toString() });
        return;
      }
    } catch {
      /* unrelated event */
    }
  }
  throw new Error(
    "Receipt succeeded but the expected event was not found. Refresh holdings before retrying.",
  );
}
