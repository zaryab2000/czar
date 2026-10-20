// T-026 acceptance (07 PRD 14 §8): on a local arc-anvil, the client deploys the real contracts (contracts/script/deploy.sh),
// calls every ICzarVault function once and decodes each revert by name, and a USDC_3009 envelope from the encoder is
// accepted by USDC through the vault's isValidSignature (the T-016 contract).
//
// Needs `arc-anvil` and `arc-forge` (T-003) on PATH, or ARC_ANVIL / ARC_FORGE pointing at them; ARC_FORGE_FLAGS may add
// compiler flags such as `--use <solc> --offline`. Every key is generated in memory for this run and never printed;
// only addresses are written to the keys file the deploy script reads.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildTree,
  derivedNonce,
  PAYEE_KIND,
  payeeLeaf,
  usdcTransferWithAuthorizationDigest,
} from "@czar/hashing";
import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  czarVaultAbi,
  czarVaultFactoryAbi,
  decodeViemError,
  encodeUsdc3009Signature,
  withFeeFloor,
} from "@czar/vault-client";

const ROOT = new URL("../../../../", import.meta.url);
const CONTRACTS = fileURLToPath(new URL("contracts/", ROOT));
const KEYS_FILE = "deployments/.vault-client-test-keys.json";
const OUT_FILE = "deployments/.vault-client-test.json";
const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 5042002; // cross-cutting §3.1: the local environment runs arc-anvil with the testnet chain id
const ANVIL_SENDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil's unlocked account 0 (no key here)
const USDC: Address = "0x3600000000000000000000000000000000000000";
const RPC_READY_TRIES = 100;
const RPC_READY_DELAY_MS = 100;
const ACCOUNT_BALANCE = parseEther("1000"); // native USDC (18 decimals on the native side, A1-05)
const VAULT_BALANCE = parseEther("10");
const ONE_USDC = 1_000_000n;
const UNIT = 1_000n;
const COUNT = 2;
const TTL_SECONDS = 300n;
const LIFETIME_SECONDS = 86_400n;
const PAYEE: Address = "0x000000000000000000000000000000000000bEEF";
const STEP = 0;

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const chain = {
  id: CHAIN_ID,
  name: "arc-anvil",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });

const keys = {
  owner: privateKeyToAccount(generatePrivateKey()),
  agent: privateKeyToAccount(generatePrivateKey()),
  autonomy: privateKeyToAccount(generatePrivateKey()),
  guardian: privateKeyToAccount(generatePrivateKey()),
  evaluator: privateKeyToAccount(generatePrivateKey()),
  admin: privateKeyToAccount(generatePrivateKey()),
  relayer: privateKeyToAccount(generatePrivateKey()),
  stranger: privateKeyToAccount(generatePrivateKey()),
};
const wallet = (who: keyof typeof keys) =>
  createWalletClient({ chain, transport, account: keys[who] });

let anvil: ChildProcess | undefined;
let factory: Address;
let vault: Address;

const splitFlags = (v: string | undefined): string[] =>
  v === undefined || v === "" ? [] : v.split(" ");

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < RPC_READY_TRIES; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, RPC_READY_DELAY_MS));
    }
  }
  throw new Error("arc-anvil did not start");
}

async function send(
  who: keyof typeof keys,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) {
  const fees = withFeeFloor({ maxFeePerGas: await pub.getGasPrice() });
  const hash = await wallet(who).writeContract({
    address,
    abi,
    functionName,
    args,
    ...fees,
  } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

beforeAll(async () => {
  anvil = spawn(
    process.env["ARC_ANVIL"] ?? "arc-anvil",
    ["--network", "arc", "--chain-id", String(CHAIN_ID), "--port", String(PORT)],
    {
      stdio: "ignore",
    },
  );
  await waitForRpc();
  const keysJson = Object.fromEntries(
    Object.entries({
      K3: keys.agent,
      K5: keys.autonomy,
      K6: keys.guardian,
      K7: keys.evaluator,
      K20: keys.admin,
    }).map(([id, a]) => [id, { address: a.address, ref: `vault-client-test-${id}` }]),
  );
  writeFileSync(fileURLToPath(new URL(KEYS_FILE, ROOT)), `${JSON.stringify(keysJson, null, 2)}\n`);
  execFileSync(
    "script/deploy.sh",
    [
      RPC,
      `../${KEYS_FILE}`,
      `../${OUT_FILE}`,
      ...splitFlags(process.env["ARC_FORGE_FLAGS"]),
      "--broadcast",
      "--unlocked",
      "--sender",
      ANVIL_SENDER,
    ],
    {
      cwd: CONTRACTS,
      stdio: "ignore",
      env: { ...process.env, ARC_FORGE: process.env["ARC_FORGE"] ?? "arc-forge" },
    },
  );
  const record = JSON.parse(readFileSync(fileURLToPath(new URL(OUT_FILE, ROOT)), "utf8")) as {
    CzarVaultFactory: Address;
  };
  factory = record.CzarVaultFactory;
  for (const a of Object.values(keys))
    await test.setBalance({ address: a.address, value: ACCOUNT_BALANCE });
  await send("owner", factory, czarVaultFactoryAbi, "createVault", [keys.owner.address]);
  vault = await pub.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [keys.owner.address],
  });
  await test.setBalance({ address: vault, value: VAULT_BALANCE });
});

afterAll(() => {
  anvil?.kill();
  for (const f of [KEYS_FILE, OUT_FILE]) rmSync(fileURLToPath(new URL(f, ROOT)), { force: true });
});

describe("vault-client against the deployed contracts", () => {
  it("a USDC_3009 envelope from the encoder pays the payee through USDC and the vault settles it (T-016)", async () => {
    const tree = buildTree([payeeLeaf(PAYEE, PAYEE_KIND.X402_PAY_TO, STEP, ONE_USDC)]);
    const now = (await pub.getBlock()).timestamp;
    await send("owner", vault, czarVaultAbi, "openEnvelope", [
      {
        cap: 2n * ONE_USDC,
        maxStepAmount: ONE_USDC,
        pocketCapBps: 0,
        expiresAt: now + LIFETIME_SECONDS,
        categoryId: `0x${"00".repeat(32)}`,
        objectiveHash: `0x${"00".repeat(32)}`,
        planHash: `0x${"00".repeat(32)}`,
        payeeRoot: tree.root,
      },
    ]);
    const envelopeId = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "envelopeCount",
    });
    const validBefore = now + TTL_SECONDS;
    await send("agent", vault, czarVaultAbi, "reserve", [
      envelopeId,
      STEP,
      PAYEE,
      ONE_USDC,
      [],
      UNIT,
      COUNT,
      validBefore,
    ]);
    const reservationId = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "reservationCount",
    });

    const nonce = derivedNonce(vault, reservationId, 0);
    const digest = usdcTransferWithAuthorizationDigest(CHAIN_ID, {
      from: vault,
      to: PAYEE,
      value: UNIT,
      validAfter: 0n,
      validBefore,
      nonce,
    });
    const agentSig = await keys.agent.sign({ hash: digest });
    const signature = encodeUsdc3009Signature({
      reservationId,
      index: 0,
      to: PAYEE,
      value: UNIT,
      validAfter: 0n,
      validBefore,
      nonce,
      agentSig,
    });
    expect(signature.length).toBe(2 + 2 * 416);

    const before = await pub.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [PAYEE],
    });
    await send("relayer", USDC, usdcAbi, "transferWithAuthorization", [
      vault,
      PAYEE,
      UNIT,
      0n,
      validBefore,
      nonce,
      signature,
    ]);
    expect(
      await pub.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [PAYEE],
      }),
    ).toBe(before + UNIT);
    expect(
      await pub.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: "authorizationState",
        args: [vault, nonce],
      }),
    ).toBe(true);
    await send("stranger", vault, czarVaultAbi, "settle", [reservationId, [0]]);
  });

  it("calls every ICzarVault function once; every revert decodes to a named custom error", async () => {
    const functions = czarVaultAbi.filter(
      (i): i is Extract<(typeof czarVaultAbi)[number], AbiFunction> => i.type === "function",
    );
    const outcomes: Record<string, string> = {};
    for (const fn of functions) {
      const args = fn.inputs.map(sample);
      try {
        await pub.simulateContract({
          address: vault,
          abi: [fn] as Abi,
          functionName: fn.name,
          args,
          account: keys.stranger,
        });
        outcomes[fn.name] = "ok";
      } catch (e) {
        const decoded = decodeViemError(e);
        outcomes[fn.name] =
          decoded?.kind === "custom" ? decoded.name : `UNDECODED ${decoded?.name ?? String(e)}`;
      }
    }
    const undecoded = Object.entries(outcomes).filter(([, o]) => o.startsWith("UNDECODED"));
    expect(undecoded).toEqual([]);
    // The caller is a stranger, so the role checks answer first (czar-vault.md §15.1, §15.3).
    expect(outcomes["withdraw"]).toBe("NotOwner");
    expect(outcomes["reserve"]).toBe("NotAgent");
    expect(outcomes["freeze"]).toBe("NotAuthorized");
    expect(outcomes["owner"]).toBe("ok");
    expect(Object.keys(outcomes)).toHaveLength(new Set(functions.map((f) => f.name)).size);
  });
});

/** A value of the right ABI type; addresses are non-zero so ZeroAddress checks do not hide the caller check. */
function sample(p: AbiParameter): unknown {
  if (p.type.endsWith("[]")) return [];
  if (p.type === "tuple") {
    const components = (p as { components: readonly AbiParameter[] }).components;
    return Object.fromEntries(components.map((c) => [c.name, sample(c)]));
  }
  if (p.type === "address") return "0x0000000000000000000000000000000000000001" satisfies Address;
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type === "bytes") return "0x" satisfies Hex;
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type.startsWith("uint") || p.type.startsWith("int"))
    return p.type === "uint8" || p.type === "uint16" || p.type === "uint32" ? 1 : 1n;
  return zeroAddress;
}
