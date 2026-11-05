// What a CZ-20 §5.11 provider instance talks to: the signer (CZ-27 `provider-call`), the chain (the ERC-8183
// escrow) and Czar's server (02 §9.2 `getJobBrief`, `uploadJobDeliverable`). Each is a port so the loop is tested
// with doubles and composed with the real adapters in `main.ts`.
import type { Address, Hash32 } from "@czar/hashing";
import type { SignerClient } from "@czar/signer";
import type { Hex } from "viem";

/** The signer calls an instance makes. It holds key references only; key material never leaves the signer. */
export type ProviderSigner = Pick<SignerClient, "sign" | "keyAddress">;

/**
 * Which ERC-8183 ABI emitted the job. The Czar base instance (`ICzarJobEscrow`, `uint48 expiredAt`) and Circle's
 * testnet instance (EIP reference shape, `uint256 expiredAt`) emit `JobCreated` with different topics and keep the
 * job in different structs; `JobFunded` and `JobSubmitted` are the same in both.
 */
export type EscrowAbi = "czar" | "circle";

export interface JobCreated {
  readonly escrow: Address;
  readonly abi: EscrowAbi;
  readonly jobId: bigint;
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  readonly expiredAt: bigint;
  readonly blockNumber: bigint;
}

export interface SentTransaction {
  readonly txHash: Hash32;
  readonly status: "success" | "reverted";
}

export interface ProviderChain {
  /** The latest block number. */
  latestBlock(): Promise<bigint>;
  /** `JobCreated` events whose `provider` is `provider`, in blocks `fromBlock..toBlock`, oldest first. */
  jobsCreated(
    provider: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly JobCreated[]>;
  /** The job's on-chain ERC-8183 `description` (`"czar:" + descriptionHash`). */
  description(job: JobCreated): Promise<string>;
  /** True once the escrow emitted `JobFunded` for the job. */
  funded(job: JobCreated): Promise<boolean>;
  /** Chain time: the latest block's timestamp, unix seconds. `submitBy` is compared with this. */
  now(): Promise<number>;
  /** Broadcasts a transaction the signer signed and waits for its receipt. */
  send(signedTransaction: Hex): Promise<SentTransaction>;
}

export interface ProviderAuth {
  readonly jobKey: Hash32;
  readonly providerAddress: Address;
  readonly issuedAt: bigint;
  readonly signature: Hex;
}

export class JobServerError extends Error {
  readonly httpStatus: number;
  constructor(route: string, httpStatus: number) {
    super(`${route} answered ${httpStatus}`);
    this.name = "JobServerError";
    this.httpStatus = httpStatus;
  }
}

export interface JobServer {
  /** `GET /v1/jobs/{jobKey}/brief`; the body as parsed JSON, not yet trusted. */
  brief(auth: ProviderAuth): Promise<unknown>;
  /** `POST /v1/jobs/{jobKey}/deliverable`; the server's `contentHash`. */
  upload(auth: ProviderAuth, body: Uint8Array): Promise<Hash32>;
}
