import { parseAbi } from "viem";

export const czarGatewayMinterReplayAbi = parseAbi([
  "function isTransferSpecHashUsed(bytes32 transferSpecHash) view returns (bool)",
]);

export const czarJobEscrowAbi = parseAbi([
  "function getJob(uint256 jobId) view returns ((address client,uint8 status,address provider,uint48 expiredAt,address evaluator,uint48 submittedAt,uint256 budget,address hook,address paymentToken,uint256 providerAgentId,string description,uint256 settledAmount,address payoutReceiver))",
  "event BudgetSet(uint256 indexed jobId,address indexed token,uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId,address indexed provider,bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId,address indexed evaluator,bytes32 reason)",
  "event JobRejected(uint256 indexed jobId,address indexed rejector,bytes32 reason)",
  "event JobExpired(uint256 indexed jobId)",
]);
