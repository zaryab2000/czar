import { parseAbi } from "viem";

export const usdcEvents = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);

export const eip7708Events = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const gatewayWalletEvents = parseAbi([
  "event Deposited(address indexed token,address indexed depositor,address indexed sender,uint256 value)",
  "event DelegateAdded(address indexed token,address indexed depositor,address delegate)",
  "event DelegateRemoved(address indexed token,address indexed depositor,address delegate)",
  "event BatchProcessed(bytes32 indexed batchId,address indexed signer,address indexed tokenAddress)",
]);

export const gatewayMinterEvents = parseAbi([
  "event AttestationUsed(address indexed token,address indexed recipient,bytes32 indexed transferSpecHash,uint32 sourceDomain,bytes32 sourceDepositor,bytes32 sourceSigner,uint256 value)",
]);

export const erc8183Events = parseAbi([
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
  "event BudgetSet(uint256 indexed jobId,uint256 amount)",
  "event JobFunded(uint256 indexed jobId,address indexed client,uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId,address indexed provider,bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId,address indexed evaluator,bytes32 reason)",
  "event JobRejected(uint256 indexed jobId,address indexed rejector,bytes32 reason)",
  "event JobExpired(uint256 indexed jobId)",
  "event PaymentReleased(uint256 indexed jobId,address indexed provider,uint256 amount)",
  "event Refunded(uint256 indexed jobId,address indexed client,uint256 amount)",
  "event EvaluatorFeePaid(uint256 indexed jobId,address indexed evaluator,uint256 amount)",
]);

export const openEvidenceEvents = parseAbi([
  "event Committed(address indexed publisher,uint8 indexed kind,uint256 indexed seq,bytes32 root,bytes32 prev,bytes32 uriHash,string uri)",
  "event Revealed(address indexed publisher,bytes32 indexed intentRoot,bytes32 batchRoot,bytes32 uriHash,string uri)",
]);
