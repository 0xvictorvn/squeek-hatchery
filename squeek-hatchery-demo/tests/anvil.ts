// Disposable local chain only. Accounts are supplied by Anvil, never production config.
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
export function artifact(name: string) {
  return JSON.parse(readFileSync(`artifacts/contracts/${name}.json`, "utf8"));
}
export async function startChain(port = 0, cap = 8n) {
  if (!port) {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
  }
  const proc = spawn(
    "anvil",
    ["--port", String(port), "--chain-id", "11155111", "--silent"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`,
    chain = { ...sepolia, rpcUrls: { default: { http: [url] } } };
  const pub = createPublicClient({
    chain,
    pollingInterval: 20,
    transport: http(url, { retryCount: 0 }),
  });
  let connected = false;
  for (let i = 0; i < 60; i++) {
    try {
      await pub.getChainId();
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!connected) {
    proc.kill();
    throw new Error("Local Anvil did not start");
  }
  const accounts = (
    (await pub.request({ method: "eth_accounts" } as never)) as Address[]
  ).map((a) => getAddress(a));
  const wallet = (account: Address) =>
    createWalletClient({ chain, transport: http(url), account });
  const deploy = async (name: string, args: unknown[] = []) => {
    const a = artifact(name);
    const h = await wallet(accounts[0]).deployContract({
      abi: a.abi,
      bytecode: a.bytecode as Hex,
      args,
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (!r.contractAddress || r.status !== "success")
      throw new Error("Local deploy failed: " + name);
    return getAddress(r.contractAddress);
  };
  const implementation = await deploy("SqueekHatchery");
  const admin = accounts[1];
  const init = encodeFunctionData({
    abi: artifact("SqueekHatchery").abi,
    functionName: "initialize",
    args: [admin, cap],
  });
  const address = await deploy("ERC1967Proxy", [implementation, init]);
  return {
    url,
    pub,
    wallet,
    accounts,
    admin,
    address,
    implementation,
    abi: artifact("SqueekHatchery").abi,
    deploy,
    stop: () => proc.kill(),
  };
}
