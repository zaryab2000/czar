// Contract functions the signer encodes itself, and the selector allow and deny lists (CZ-27 §5.2).
// Signatures mirror contracts/src/interfaces; a test checks them against the Solidity sources.
import { parseAbi, toFunctionSelector, type AbiFunction, type Hex } from "viem";

const OPEN_ENVELOPE_PARAMS =
  "(uint256 cap,uint256 maxStepAmount,uint16 pocketCapBps,uint64 expiresAt,bytes32 categoryId,bytes32 objectiveHash,bytes32 planHash,bytes32 payeeRoot)";
const WEBAUTHN_AUTH =
  "(uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s,bytes authenticatorData,string clientDataJSON)";

export const VAULT_ABI = parseAbi([
  `function openEnvelope(${OPEN_ENVELOPE_PARAMS} p)`,
  "function closeEnvelope(uint64 envelopeId)",
  "function forceCloseEnvelope(uint64 envelopeId)",
  "function reserve(uint64 envelopeId, uint32 stepIndex, address payee, uint256 stepCap, bytes32[] proof, uint256 unitAmount, uint32 count, uint64 validBefore)",
  "function reserveWithDigests(uint64 envelopeId, uint32 stepIndex, address payee, uint256 stepCap, bytes32[] proof, uint256 unitAmount, uint32 count, uint64 validBefore)",
  "function settle(uint64 reservationId, uint32[] indices)",
  "function finalize(uint64 reservationId, uint32 fromIndex, uint32 toIndex)",
  "function registerPocket(uint64 envelopeId, address pocket, bytes32[] proof)",
  "function grantPocketGas(address pocket, uint256 units)",
  "function fundPocket(address pocket, uint256 amount)",
  "function requestPullback(address pocket, uint256 value, uint256 maxFee, uint256 maxBlockHeight)",
  "function confirmPullback(uint64 pullbackId)",
  "function cancelPullback(uint64 pullbackId)",
  "function writeOffPocket(address pocket)",
  "function recordManualReturn(address pocket, uint256 amount)",
  "function openJob(uint64 envelopeId, uint32 stepIndex, address provider, uint256 stepCap, bytes32[] proof, uint64 expiredAt, bytes32 descriptionHash)",
  "function fundJob(bytes32 jobKey)",
  "function syncJob(bytes32 jobKey)",
  "function claimJobRefund(bytes32 jobKey)",
  "function cancelJob(bytes32 jobKey)",
  "function raiseAutoLimit(bytes32 categoryId, uint256 newLimit, uint64 periodId, uint256 deadline, bytes sig)",
  "function lowerAutoLimit(bytes32 categoryId, uint256 newLimit)",
  "function withdraw(address to, uint256 amount)",
  "function setCategoryLimits(bytes32 categoryId, uint256 userMax, uint256 autoLimit)",
  "function freeze()",
  "function unfreeze()",
  "function rotateSigners(address agent, address autonomy, address evaluator_)",
  "function setPasskey(bytes32 qx, bytes32 qy, bytes32 rpIdHash)",
  "function setMaxPullbackFee(uint256 newMax)",
  `function executeOwnerAction(uint8 action, bytes payload, uint256 deadline, ${WEBAUTHN_AUTH} auth)`,
]);

export const FACTORY_ABI = parseAbi([
  "function createVault(address ownerAccount)",
  "function pause()",
  "function unpause()",
  "function queueGuardian(address newGuardian)",
  "function applyGuardian(bytes32 changeId)",
  "function queueDefaults(address agentSigner, address autonomySigner, address evaluator)",
  "function applyDefaults(bytes32 changeId, address agentSigner, address autonomySigner, address evaluator)",
  "function cancelChange(bytes32 changeId)",
]);

export const JOB_ESCROW_ABI = parseAbi([
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
]);

export const OEL_ABI = parseAbi([
  "function commit(uint8 kind, bytes32 root, bytes32 prev, bytes32 uriHash, string uri)",
  "function reveal(bytes32 intentRoot, bytes32 batchRoot, bytes32 uriHash, string uri)",
]);

export const GATEWAY_WALLET_ABI = parseAbi([
  "function addDelegate(address token, address delegate)",
  "function initiateWithdrawal(address token, uint256 value)",
  "function withdraw(address token)",
]);

export const GATEWAY_MINTER_ABI = parseAbi([
  "function gatewayMint(bytes attestationPayload, bytes signature)",
]);

export const USDC_ABI = parseAbi(["function transfer(address to, uint256 value)"]);

export type VaultFunctionName = Extract<(typeof VAULT_ABI)[number], AbiFunction>["name"];

/** K3 `vault-call` allowlist (CZ-27 §5.2). */
export const K3_ALLOWED: readonly VaultFunctionName[] = [
  "openEnvelope",
  "reserve",
  "reserveWithDigests",
  "settle",
  "finalize",
  "registerPocket",
  "grantPocketGas",
  "fundPocket",
  "requestPullback",
  "confirmPullback",
  "cancelPullback",
  "writeOffPocket",
  "openJob",
  "fundJob",
  "syncJob",
  "claimJobRefund",
  "closeEnvelope",
  "lowerAutoLimit",
  "freeze",
];

/** Never signable for K3 (CZ-27 §5.2, RV-055); also any factory selector. */
export const K3_NEVER: readonly VaultFunctionName[] = [
  "withdraw",
  "unfreeze",
  "rotateSigners",
  "setCategoryLimits",
  "setPasskey",
  "recordManualReturn",
  "forceCloseEnvelope",
  "setMaxPullbackFee",
  "raiseAutoLimit",
  "executeOwnerAction",
  "cancelJob",
];

/** Spending selectors: the freeze check applies (D72). */
export const K3_SPENDING: ReadonlySet<VaultFunctionName> = new Set<VaultFunctionName>([
  "reserve",
  "reserveWithDigests",
  "registerPocket",
  "grantPocketGas",
  "fundPocket",
  "openJob",
  "fundJob",
  "openEnvelope",
]);

/** Selectors the relayer may send: anyone-callable vault functions and `gatewayMint` (CZ-27 §5.1). */
export const RELAYER_VAULT_ALLOWED: readonly VaultFunctionName[] = [
  "raiseAutoLimit",
  "settle",
  "finalize",
  "confirmPullback",
  "syncJob",
  "claimJobRefund",
  "closeEnvelope",
  "executeOwnerAction",
];

export const selectorOf = (abi: readonly unknown[], name: string): Hex => {
  const fn = (abi as readonly AbiFunction[]).find(
    (item) => item.type === "function" && item.name === name,
  );
  if (fn === undefined) throw new Error(`no function ${name}`);
  return toFunctionSelector(fn);
};

export const FACTORY_SELECTORS: ReadonlySet<Hex> = new Set(
  FACTORY_ABI.map((fn) => toFunctionSelector(fn)),
);
