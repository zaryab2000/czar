import { defineChain, type Address, type Hex, type PublicClient } from "viem";
import type { KeyId } from "./kinds.ts";
import type { SignerProcessOptions } from "./main.ts";
import type { TransactionPreparer } from "./service.ts";
import type { SignerAlertPort } from "./service.ts";
import type { GasRefillChainAdapters } from "./gas-refill.ts";
import type { AuditQueryExecutor } from "./postgres-audit.ts";

const LOCAL_CALLERS: Readonly<Record<string, readonly KeyId[]>> = {
  "cz-15": ["K3", "K4"],
  "cz-24": ["K5"],
  "cz-16": ["K7"],
  "cz-17": ["K8"],
  "cz-20": ["K10"],
  relayer: ["relayer"],
};

const ALLOWED_CALLERS: Readonly<Record<string, readonly string[]>> = {
  server: ["cz-15", "cz-16", "cz-17", "cz-24"],
  merchants: ["cz-20"],
  "relayer-jobs": ["relayer"],
};

export function createLocalSignerPolicy(): Pick<
  SignerProcessOptions,
  "callers" | "allowedCallers"
> {
  return { callers: LOCAL_CALLERS, allowedCallers: ALLOWED_CALLERS };
}

/** Create the RPC-backed EIP-1559 transaction filler used by the signer process. */
export function createRpcTransactionPreparer(input: {
  readonly chainId: number;
  /** Labels the chain only; requests go through `client`. */
  readonly rpcUrl?: string;
  readonly client: Pick<PublicClient, "estimateGas" | "getChainId" | "prepareTransactionRequest">;
}): TransactionPreparer {
  const chain = defineChain({
    id: input.chainId,
    name: "Arc local",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: input.rpcUrl === undefined ? [] : [input.rpcUrl] } },
  });
  return async (from, call) => {
    const connectedChainId = await input.client.getChainId();
    if (connectedChainId !== input.chainId)
      throw new Error(`RPC chain ${connectedChainId}; expected ${input.chainId}`);
    // Estimate without a fee cap: on Arc a fee-capped estimate pre-charges gas × fee from the USDC the call
    // moves, so a pocket-return of balance − gasReserve (SCR-152) would revert in estimation.
    const gas = await input.client.estimateGas({
      account: from as Address,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const prepared = await input.client.prepareTransactionRequest({
      account: from as Address,
      chain,
      type: "eip1559",
      to: call.to,
      data: call.data,
      value: call.value,
      gas,
    });
    return { ...prepared, chainId: input.chainId };
  };
}

/** Bind the refill job to Arc RPC without exposing a private key to the caller process. */
export function createRpcGasRefillAdapters(input: {
  readonly client: Pick<
    PublicClient,
    "getBalance" | "sendRawTransaction" | "waitForTransactionReceipt"
  >;
}): GasRefillChainAdapters {
  return {
    getNativeBalance: (address, blockNumber) =>
      blockNumber === undefined
        ? input.client.getBalance({ address })
        : input.client.getBalance({ address, blockNumber }),
    async submitTransaction(transaction: Hex) {
      const hash = await input.client.sendRawTransaction({ serializedTransaction: transaction });
      const receipt = await input.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`refill transaction ${hash} reverted`);
      return { blockNumber: receipt.blockNumber };
    },
  };
}

/** Compose the local signer adapters shared by the server, merchant and relayer processes. */
export function createLocalSignerAdapters(input: {
  readonly rpcUrl: string;
  readonly postgres: AuditQueryExecutor;
  readonly client: Pick<
    PublicClient,
    | "estimateGas"
    | "getChainId"
    | "prepareTransactionRequest"
    | "getBalance"
    | "sendRawTransaction"
    | "waitForTransactionReceipt"
  >;
  readonly chainId: number;
  readonly alert: SignerAlertPort;
}): Pick<SignerProcessOptions, "auditExecutor" | "prepareTransaction" | "refill" | "alert"> {
  return {
    auditExecutor: input.postgres,
    prepareTransaction: createRpcTransactionPreparer(input),
    refill: createRpcGasRefillAdapters(input),
    alert: input.alert,
  };
}
