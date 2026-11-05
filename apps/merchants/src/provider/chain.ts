// The provider's view of the ERC-8183 escrow over RPC (CZ-20 §5.11 steps 1 and 5): `JobCreated` naming its own
// key, `JobFunded`, the job's on-chain `description`, chain time, and broadcasting what the signer signed.
import type { Address, Hash32 } from "@czar/hashing";
import { parseAbi, type Hex, type PublicClient } from "viem";
import type { EscrowAbi, JobCreated, ProviderChain } from "#src/provider/ports";

/** `ICzarJobEscrow` (and `MockCzarJobEscrow`): `uint48 expiredAt`, `getJob` returns the base struct. */
const CZAR_ESCROW_ABI = parseAbi([
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint48 expiredAt, address hook)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "struct Job { address client; uint8 status; address provider; uint48 expiredAt; address evaluator; uint48 submittedAt; uint256 budget; address hook; address paymentToken; uint256 providerAgentId; string description; uint256 settledAmount; address payoutReceiver; }",
  "function getJob(uint256 jobId) view returns (Job)",
]);

/** Circle's testnet instance (and `MockCircleAgenticCommerce`): the EIP reference shape (A4-06). */
const CIRCLE_ESCROW_ABI = parseAbi([
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; }",
  "function getJob(uint256 jobId) view returns (Job)",
]);

const ABIS: Readonly<Record<EscrowAbi, typeof CZAR_ESCROW_ABI | typeof CIRCLE_ESCROW_ABI>> = {
  czar: CZAR_ESCROW_ABI,
  circle: CIRCLE_ESCROW_ABI,
};

export type ProviderChainClient = Pick<
  PublicClient,
  | "getBlock"
  | "getBlockNumber"
  | "getContractEvents"
  | "readContract"
  | "sendRawTransaction"
  | "waitForTransactionReceipt"
>;

export function createRpcProviderChain(options: {
  readonly client: ProviderChainClient;
  /** The escrow this instance serves: the deployment's `jobEscrow`. */
  readonly escrow: Address;
}): ProviderChain {
  const { client, escrow } = options;
  return {
    // No cached block number: a cached one hides blocks mined since, and a watch step would miss them.
    latestBlock: () => client.getBlockNumber({ cacheTime: 0 }),
    async jobsCreated(provider, fromBlock, toBlock) {
      const found: JobCreated[] = [];
      for (const abi of ["czar", "circle"] as const) {
        const logs = await client.getContractEvents({
          address: escrow,
          abi: ABIS[abi],
          eventName: "JobCreated",
          args: { provider },
          fromBlock,
          toBlock,
          strict: true,
        });
        for (const log of logs) {
          const args = log.args as {
            jobId: bigint;
            client: Address;
            provider: Address;
            evaluator: Address;
            expiredAt: bigint | number;
          };
          found.push({
            escrow,
            abi,
            jobId: args.jobId,
            client: args.client,
            provider: args.provider,
            evaluator: args.evaluator,
            expiredAt: BigInt(args.expiredAt),
            blockNumber: log.blockNumber ?? fromBlock,
          });
        }
      }
      return found.toSorted((a, b) =>
        a.blockNumber === b.blockNumber
          ? Number(a.jobId - b.jobId)
          : Number(a.blockNumber - b.blockNumber),
      );
    },
    async description(job) {
      const result = (await client.readContract({
        address: job.escrow,
        abi: ABIS[job.abi],
        functionName: "getJob",
        args: [job.jobId],
      })) as { description: string };
      return result.description;
    },
    async funded(job) {
      const logs = await client.getContractEvents({
        address: job.escrow,
        abi: ABIS[job.abi],
        eventName: "JobFunded",
        args: { jobId: job.jobId },
        fromBlock: job.blockNumber,
        toBlock: "latest",
        strict: true,
      });
      return logs.length > 0;
    },
    async now() {
      const block = await client.getBlock({ blockTag: "latest" });
      return Number(block.timestamp);
    },
    async send(signedTransaction: Hex) {
      const txHash = await client.sendRawTransaction({ serializedTransaction: signedTransaction });
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      return { txHash: txHash as Hash32, status: receipt.status };
    },
  };
}
