// Local Gateway Nanopayments seller (Arc testnet), adapted from arc-lab/scripts/seller.ts.
// Binds to 127.0.0.1 only. payTo is the throwaway MERCHANT address.
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { GATEWAY_API, log, readAddr } from "./common.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env["SELLER_PORT"] ?? 4022);
const PRICE = process.env["SELLER_PRICE"] ?? "$0.001";
const payTo = readAddr("merchant");

const app = express();
const gateway = createGatewayMiddleware({
  sellerAddress: payTo,
  facilitatorUrl: GATEWAY_API,
  networks: ["eip155:5042002"],
  description: "czar a2 test seller (Gateway Nanopayments, Arc testnet)",
});

app.use((req, _res, next) => {
  log("seller.request", { method: req.method, url: req.url, hasPayment: Boolean(req.header("payment-signature")) });
  next();
});

app.get("/premium", gateway.require(PRICE), (req, res) => {
  const payment = (req as typeof req & { payment?: Record<string, unknown> }).payment ?? {};
  log("seller.handler", { payment });
  res.json({ data: "czar a2 paid resource", payment });
});

app.listen(PORT, HOST, () => log("seller.listening", { url: `http://${HOST}:${PORT}/premium`, payTo, price: PRICE }));
