import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_GATEWAY_MINTER,
  CANONICAL_GATEWAY_WALLET,
  GatewayDoublesRefused,
  placeGatewayDoubles,
} from "./gateway-doubles.ts";

const RPC_URL = "http://127.0.0.1:8545";
const CONTROLLER = "0x00000000000000000000000000000000000000a1";
const USDC = "0x3600000000000000000000000000000000000000";
const INIT_SELECTOR = "5858cf0d";

function artifacts(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-doubles-"));
  for (const name of ["MockGatewayWallet", "MockGatewayMinter"]) {
    mkdirSync(join(dir, `${name}.sol`), { recursive: true });
    writeFileSync(
      join(dir, `${name}.sol`, `${name}.json`),
      JSON.stringify({
        bytecode: { object: name === "MockGatewayWallet" ? "0x6001" : "0x6002" },
        methodIdentifiers: { "initializeDouble(address)": INIT_SELECTOR },
      }),
    );
  }
  return dir;
}

type RpcOverrides = {
  readonly nodeInfo?: unknown;
  readonly canonicalCode?: string;
};

function scriptedRpc(overrides: RpcOverrides = {}) {
  let deployed = 0;
  return vi.fn(async (method: string, params: readonly unknown[]) => {
    switch (method) {
      case "anvil_nodeInfo":
        if (overrides.nodeInfo instanceof Error) throw overrides.nodeInfo;
        return overrides.nodeInfo ?? { forkConfig: { forkUrl: null } };
      case "eth_getCode": {
        const address = String(params[0]).toLowerCase();
        if (address === CANONICAL_GATEWAY_WALLET || address === CANONICAL_GATEWAY_MINTER) {
          return overrides.canonicalCode ?? "0x";
        }
        return "0x60806040";
      }
      case "eth_accounts":
        return [CONTROLLER];
      case "eth_sendTransaction":
        deployed += 1;
        return `0x${deployed.toString(16).padStart(64, "0")}`;
      case "eth_getTransactionReceipt":
        return {
          status: "0x1",
          contractAddress: `0x${String(params[0]).slice(-40)}`,
        };
      case "anvil_setCode":
        return null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

describe("SCR-150 §1 Gateway double placement", () => {
  it("deploys, copies to the canonical addresses and initializes from the controller", async () => {
    const rpc = scriptedRpc();
    const placed = await placeGatewayDoubles({ rpcUrl: RPC_URL, rpc, artifactsDir: artifacts() });
    expect(placed).toEqual({
      gatewayWallet: CANONICAL_GATEWAY_WALLET,
      gatewayMinter: CANONICAL_GATEWAY_MINTER,
      controller: CONTROLLER,
    });
    const setCode = rpc.mock.calls.filter(([method]) => method === "anvil_setCode");
    expect(setCode.map(([, params]) => params[0])).toEqual([
      CANONICAL_GATEWAY_WALLET,
      CANONICAL_GATEWAY_MINTER,
    ]);
    const sends = rpc.mock.calls
      .filter(([method]) => method === "eth_sendTransaction")
      .map(([, params]) => params[0] as Record<string, string>);
    expect(sends[0]?.["data"]).toBe(`0x6001${USDC.slice(2).padStart(64, "0")}`);
    expect(sends[1]).toEqual({
      from: CONTROLLER,
      to: CANONICAL_GATEWAY_WALLET,
      data: `0x${INIT_SELECTOR}${USDC.slice(2).padStart(64, "0")}`,
    });
    expect(sends[2]?.["data"]).toBe("0x6002");
    expect(sends[3]?.["to"]).toBe(CANONICAL_GATEWAY_MINTER);
  });

  it("refuses a fork", async () => {
    const rpc = scriptedRpc({
      nodeInfo: { forkConfig: { forkUrl: "https://rpc.testnet.arc.io" } },
    });
    await expect(
      placeGatewayDoubles({ rpcUrl: RPC_URL, rpc, artifactsDir: artifacts() }),
    ).rejects.toMatchObject({ reason: "fork" });
    expect(rpc.mock.calls.some(([method]) => method === "anvil_setCode")).toBe(false);
  });

  it("refuses to overwrite existing canonical code", async () => {
    const rpc = scriptedRpc({ canonicalCode: "0x6080" });
    await expect(
      placeGatewayDoubles({ rpcUrl: RPC_URL, rpc, artifactsDir: artifacts() }),
    ).rejects.toMatchObject({ reason: "canonical-code-present" });
    expect(rpc.mock.calls.some(([method]) => method === "eth_sendTransaction")).toBe(false);
  });

  it("refuses a node that does not answer anvil_nodeInfo", async () => {
    const rpc = scriptedRpc({ nodeInfo: new Error("method not found") });
    await expect(
      placeGatewayDoubles({ rpcUrl: RPC_URL, rpc, artifactsDir: artifacts() }),
    ).rejects.toMatchObject({ reason: "not-anvil" });
  });

  it("refuses a non-loopback RPC before any call", async () => {
    const rpc = scriptedRpc();
    await expect(
      placeGatewayDoubles({ rpcUrl: "https://rpc.testnet.arc.io", rpc, artifactsDir: artifacts() }),
    ).rejects.toBeInstanceOf(GatewayDoublesRefused);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("names the build step when the artifacts are missing", async () => {
    const rpc = scriptedRpc();
    await expect(
      placeGatewayDoubles({
        rpcUrl: RPC_URL,
        rpc,
        artifactsDir: join(tmpdir(), "czar-no-such-artifacts"),
      }),
    ).rejects.toMatchObject({ reason: "artifact-missing" });
  });
});
