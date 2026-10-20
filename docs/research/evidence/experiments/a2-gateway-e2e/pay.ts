// Buyer: deposit into GatewayWallet, then pay the local seller once. Records timings in raw/events.jsonl.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { RPC, log, readKey } from "./common.ts";

const SELLER_URL = process.env["SELLER_URL"] ?? "http://127.0.0.1:4022/premium";
const DEPOSIT = process.env["GATEWAY_DEPOSIT"] ?? "2";

const client = new GatewayClient({ chain: "arcTestnet", privateKey: readKey("buyer"), rpcUrl: RPC });
log("buyer.address", { address: client.address });
log("buyer.balances.before", { balances: await client.getBalances() });

const before = await client.getBalances();
if (before.gateway.available < 10_000n) {
  const t0 = Date.now();
  const deposit = await client.deposit(DEPOSIT);
  log("buyer.deposit.mined", { deposit, ms: Date.now() - t0 });
  for (let i = 0; i < 60; i += 1) {
    const now = await client.getBalances();
    if (now.gateway.available > before.gateway.available) {
      log("buyer.deposit.credited", { msSinceDepositStart: Date.now() - t0, gateway: now.gateway });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

log("buyer.supports", { support: await client.supports(SELLER_URL) });
const t1 = Date.now();
const paid = await client.pay(SELLER_URL);
log("buyer.pay.done", { ms: Date.now() - t1, transaction: paid.transaction, status: paid.status, amount: paid.amount });
log("buyer.balances.after", { balances: await client.getBalances() });
