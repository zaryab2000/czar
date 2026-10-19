// Shared helpers for the A2 experiment. Keys are read from *.key files (mode 600) and never printed.
import { appendFileSync, readFileSync } from "node:fs";
import type { Hex } from "viem";

export const RPC = "https://rpc.testnet.arc.io";
export const GATEWAY_API = "https://gateway-api-testnet.circle.com";
export const USDC = "0x3600000000000000000000000000000000000000";
export const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const dir = new URL("./", import.meta.url);
export const readKey = (name: string): Hex => readFileSync(new URL(`${name}.key`, dir), "utf8").trim() as Hex;
export const readAddr = (name: string): Hex => readFileSync(new URL(`${name}.addr`, dir), "utf8").trim() as Hex;

/** Prints and appends a timestamped event to raw/events.jsonl. */
export function log(event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  console.log(line);
  appendFileSync(new URL("raw/events.jsonl", dir), `${line}\n`);
}
