// Non-delayed withdrawal: same-chain burn intent -> POST /v1/transfer -> GatewayMinter.gatewayMint on Arc testnet.
// Mirrors GatewayClient.withdraw() from @circle-fin/x402-batching 3.5.0 but logs each step and mints via RPC below
// (the SDK hardcodes https://rpc.testnet.arc.network for the mint, which did not resolve from this machine).
import { CHAIN_CONFIGS, GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, createWalletClient, http, pad, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { GATEWAY_API, RPC, log, readAddr, readKey } from "./common.ts";

const AMOUNT = process.env["WITHDRAW_AMOUNT"] ?? "0.5";
const MAX_FEE = process.env["WITHDRAW_MAX_FEE"] ?? "0.01";
// SIGNER signs the burn intent; DEPOSITOR is the Gateway balance debited. CONTRACT_SIGNER=1 sets contractSigner: true
// (ERC-1271 path). Defaults: buyer withdraws its own balance.
const SIGNER = process.env["SIGNER"] ?? "buyer";
const DEPOSITOR = process.env["DEPOSITOR"] ?? "buyer";
const CONTRACT_SIGNER = process.env["CONTRACT_SIGNER"] === "1";
const account = privateKeyToAccount(readKey(SIGNER));
const depositor = readAddr(DEPOSITOR);
const client = new GatewayClient({ chain: "arcTestnet", privateKey: readKey(SIGNER), rpcUrl: RPC });
const cfg = CHAIN_CONFIGS.arcTestnet;
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
// gatewayMint is permissionless when destinationCaller is zero, so the funded buyer pays mint gas in every case.
const wallet = createWalletClient({ account: privateKeyToAccount(readKey("buyer")), chain: arcTestnet, transport: http(RPC) });

log("withdraw.before", { SIGNER, DEPOSITOR, CONTRACT_SIGNER, balances: await client.getBalances(depositor) });
type BurnIntent = { spec: { sourceDepositor: Hex; sourceSigner: Hex } };
const makeIntent = (client as unknown as { createBurnIntent: (...a: unknown[]) => BurnIntent }).createBurnIntent.bind(client);
const burnIntent = makeIntent(cfg, cfg, parseUnits(AMOUNT, 6), account.address, parseUnits(MAX_FEE, 6));
burnIntent.spec.sourceDepositor = pad(depositor.toLowerCase() as Hex, { size: 32 });
// For the ERC-1271 path the contract is the signer of record; its owner EOA produces the bytes it accepts.
// SIGNER_OF_RECORD (default: DEPOSITOR) lets a contract act as an ERC-1271 *delegate* of another depositor.
const signerOfRecord = readAddr(process.env["SIGNER_OF_RECORD"] ?? DEPOSITOR);
if (CONTRACT_SIGNER) burnIntent.spec.sourceSigner = pad(signerOfRecord.toLowerCase() as Hex, { size: 32 });
const b32 = [
  "version:uint32", "sourceDomain:uint32", "destinationDomain:uint32", "sourceContract:bytes32",
  "destinationContract:bytes32", "sourceToken:bytes32", "destinationToken:bytes32", "sourceDepositor:bytes32",
  "destinationRecipient:bytes32", "sourceSigner:bytes32", "destinationCaller:bytes32", "value:uint256",
  "salt:bytes32", "hookData:bytes",
].map((f) => ({ name: f.split(":")[0] as string, type: f.split(":")[1] as string }));
const signature = await account.signTypedData({
  domain: { name: "GatewayWallet", version: "1" },
  types: {
    TransferSpec: b32,
    BurnIntent: [
      { name: "maxBlockHeight", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "spec", type: "TransferSpec" },
    ],
  },
  primaryType: "BurnIntent",
  message: burnIntent as never,
});

const t0 = Date.now();
const response = await fetch(`${GATEWAY_API}/v1/transfer`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([{ burnIntent, signature, ...(CONTRACT_SIGNER ? { contractSigner: true } : {}) }], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
});
const result = (await response.json()) as { transferId?: string; attestation?: Hex; signature?: Hex; fees?: unknown; expirationBlock?: string };
log("withdraw.attestation", {
  httpStatus: response.status, ms: Date.now() - t0, transferId: result.transferId, fees: result.fees,
  expirationBlock: result.expirationBlock, hasAttestation: Boolean(result.attestation), raw: result.attestation ? undefined : result,
});
if (!result.attestation || !result.signature) process.exit(1);

const mintHash = await wallet.writeContract({
  address: cfg.gatewayMinter,
  abi: parseAbi(["function gatewayMint(bytes attestationPayload, bytes signature)"]),
  functionName: "gatewayMint",
  args: [result.attestation, result.signature],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
log("withdraw.minted", { mintHash, block: receipt.blockNumber, status: receipt.status, msSinceRequest: Date.now() - t0 });
log("withdraw.after", { balances: await client.getBalances(depositor) });
