// Bonus: does the nanopayments API accept a payment for the BUYER's balance signed by an on-chain DELEGATE?
// Step 1: buyer calls GatewayWallet.addDelegate(USDC, delegate).
// Step 2: delegate signs the GatewayWalletBatched TransferWithAuthorization with from = buyer, and pays the seller.
import { BatchEvmScheme, GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { GATEWAY_WALLET, RPC, USDC, log, readAddr, readKey } from "./common.ts";

const SELLER_URL = process.env["SELLER_URL"] ?? "http://127.0.0.1:4022/premium";
const buyer = privateKeyToAccount(readKey("buyer"));
const delegate = privateKeyToAccount(readKey("delegate"));
const abi = parseAbi([
  "function addDelegate(address token, address delegate)",
  "function isAuthorizedForBalance(address token, address depositor, address addr) view returns (bool)",
]);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC) });

const authorized = () =>
  publicClient.readContract({
    address: GATEWAY_WALLET, abi, functionName: "isAuthorizedForBalance", args: [USDC, buyer.address, delegate.address],
  });

if (!(await authorized())) {
  const hash = await buyerWallet.writeContract({
    address: GATEWAY_WALLET, abi, functionName: "addDelegate", args: [USDC, delegate.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  log("delegate.added", { hash, block: receipt.blockNumber, status: receipt.status });
}
log("delegate.isAuthorizedForBalance", { value: await authorized(), buyer: buyer.address, delegate: delegate.address });

// The GatewayClient is only used for its pay() HTTP flow; the scheme signs with the delegate key but claims from = buyer.
const client = new GatewayClient({ chain: "arcTestnet", privateKey: readKey("delegate"), rpcUrl: RPC });
const scheme = new BatchEvmScheme({
  address: readAddr("buyer"),
  signTypedData: (params) => delegate.signTypedData(params as Parameters<typeof delegate.signTypedData>[0]),
});
(client as unknown as { batchScheme: BatchEvmScheme }).batchScheme = scheme;

const t0 = Date.now();
try {
  const paid = await client.pay(SELLER_URL);
  log("delegate.pay.result", { ok: true, ms: Date.now() - t0, transaction: paid.transaction, status: paid.status });
} catch (err) {
  log("delegate.pay.result", { ok: false, ms: Date.now() - t0, error: String(err) });
}
