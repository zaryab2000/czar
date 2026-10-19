// Computes EIP-712 type hashes, domain separators and test digests for Czar specs 02/03.
// Run: ES modules resolve packages next to the script, so copy it into a scratch directory that has
// `npm install viem@2.57.2`, then: node <scratch>/compute-eip712-vectors.mjs > eip712-vectors.json
// Check: node compute-eip712-vectors.mjs | diff - eip712-vectors.json  (must print nothing)
// Changed 2026-10-19: ReceiptAttestation type and vector, SL_RECEIPT kind tag v2 (RV-013); autonomyRaise deadline
// moved inside its period (RV-061); BriefRequest type, domain and vector (RV-025). Output is fully deterministic (`generatedAt` is the spec date).
import { keccak256, toHex, hashTypedData, hashDomain, hashStruct, encodeAbiParameters, parseAbiParameters, pad } from "viem";
const th = (s) => keccak256(toHex(s));
// generatedAt is the spec date, not the wall clock, so a rerun reproduces the file byte for byte
const out = { generatedAt: "2026-10-19", tool: "viem (hashTypedData/keccak256)", typeHashes: {}, domains: {}, vectors: {} };
const TYPES = {
  // USDC EIP-3009 (circlefin/stablecoin-evm release-2026-08-12T202509, contracts/v2/EIP3009.sol)
  TransferWithAuthorization: "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  CancelAuthorization: "CancelAuthorization(address authorizer,bytes32 nonce)",
  // Gateway (circlefin/evm-gateway-contracts c21d2d2, src/lib/TransferSpec.sol, BurnIntents.sol)
  TransferSpec: "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
  BurnIntent: "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
  EIP712Domain_nameVersion: "EIP712Domain(string name,string version)",
  EIP712Domain_full: "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  EIP712Domain_noContract: "EIP712Domain(string name,string version,uint256 chainId)",
  // Selection Layer §5.8 (adopted verbatim)
  Receipt: "Receipt(bytes32 paymentRefHash,bytes32 requestCommit,bytes32 responseCommit,uint16 statusCode,string originAsserted,bytes32 requirementsHashSeen,uint64 tRequest,uint64 tPaymentSigned,uint64 tComplete,uint8 outcome,bytes32 localChecksCommit,uint8 disclosure,uint64 createdAt)",
  ProbeObservation: "ProbeObservation(bytes32 intentHash,uint32 itemIndex,bytes32 paymentRefHash,bytes32 requestCommit,bytes32 responseCommit,uint16 statusCode,string originAsserted,bytes32 requirementsHashSeen,uint64 tRequest,uint64 tPaymentSigned,uint64 tComplete,uint8 outcome,string skipReason,uint64 createdAt)",
  ValidationReport: "ValidationReport(bytes32 obsId,bytes32 profileId,bytes32 methodVersion,uint8 assignmentKind,bytes32 saltCommit,bytes32 checksCommit,uint64 createdAt)",
  DeliveryAttestation: "DeliveryAttestation(bytes32 paymentRefHash,bytes32 responseCommit,uint64 ts)",
  Correction: "Correction(bytes32 targetId,uint8 kind,bytes32 evidenceHash,uint64 createdAt)",
  ServiceClaim: "ServiceClaim(bytes32 serviceId,address payTo,string origin,uint64 deadline)",
  // Czar vault types (spec 02 §6)
  AutonomyRaise: "AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline)",
  OwnerAction: "OwnerAction(uint8 action,bytes32 payloadHash,uint256 nonce,uint256 deadline)",
  // Czar vault-bound wrapper for SL_RECEIPT signatures (RV-013): the agent signs this under the CzarVault domain
  ReceiptAttestation: "ReceiptAttestation(bytes32 receiptStructHash)",
  // Provider authentication for GET /v1/jobs/{jobKey}/brief (RV-025), domain CzarJobBrief v1 with chainId, no contract
  BriefRequest: "BriefRequest(bytes32 jobKey,uint64 issuedAt)",
};
for (const [k, s] of Object.entries(TYPES)) out.typeHashes[k] = { typeString: s, typeHash: th(s) };
// Domains
const USDC = "0x3600000000000000000000000000000000000000";
const VAULT = "0x00000000000000000000000000000000000c2a21"; // invented example vault address
for (const chainId of [5042, 5042002]) {
  out.domains[`USDC_${chainId}`] = hashDomain({ domain: { name: "USDC", version: "2", chainId, verifyingContract: USDC }, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}] } });
  out.domains[`CzarVault_${chainId}_exampleVault`] = hashDomain({ domain: { name: "CzarVault", version: "1", chainId, verifyingContract: VAULT }, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}] } });
  out.domains[`CzarJobBrief_${chainId}`] = hashDomain({ domain: { name: "CzarJobBrief", version: "1", chainId }, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"}] } });
  out.domains[`SelectionLayer_${chainId}`] = hashDomain({ domain: { name: "SelectionLayer", version: "1", chainId }, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"}] } });
}
out.domains.GatewayWallet_nameVersionOnly = hashDomain({ domain: { name: "GatewayWallet", version: "1" }, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"}] } });
// Vectors (all values invented)
const twa = { from: VAULT, to: "0x000000000000000000000000000000000000bEEF", value: 100000n, validAfter: 0n, validBefore: 1760800000n, nonce: "0x1111111111111111111111111111111111111111111111111111111111111111" };
out.vectors.usdcTransferWithAuthorization_5042002 = { message: twa, digest: hashTypedData({ domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC }, types: { TransferWithAuthorization: [{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}] }, primaryType: "TransferWithAuthorization", message: twa }) };
const b32 = (a) => pad(a.toLowerCase(), { size: 32 });
const spec = { version: 1, sourceDomain: 26, destinationDomain: 26, sourceContract: b32("0x0077777d7EBA4688BDeF3E311b846F25870A19B9"), destinationContract: b32("0x0022222ABE238Cc2C7Bb1f21003F0a260052475B"), sourceToken: b32(USDC), destinationToken: b32(USDC), sourceDepositor: b32("0x000000000000000000000000000000000000P0C0".replace("P0C0","b0c0")), destinationRecipient: b32(VAULT), sourceSigner: b32(VAULT), destinationCaller: b32("0x0000000000000000000000000000000000000000"), value: 199600n, salt: "0x2222222222222222222222222222222222222222222222222222222222222222", hookData: "0x" };
const burn = { maxBlockHeight: 68000000n, maxFee: 10000n, spec };
out.vectors.gatewayBurnIntent_sameChain = { message: burn, digest: hashTypedData({ domain: { name: "GatewayWallet", version: "1" }, types: { TransferSpec: [["version","uint32"],["sourceDomain","uint32"],["destinationDomain","uint32"],["sourceContract","bytes32"],["destinationContract","bytes32"],["sourceToken","bytes32"],["destinationToken","bytes32"],["sourceDepositor","bytes32"],["destinationRecipient","bytes32"],["sourceSigner","bytes32"],["destinationCaller","bytes32"],["value","uint256"],["salt","bytes32"],["hookData","bytes"]].map(([name,type])=>({name,type})), BurnIntent: [{name:"maxBlockHeight",type:"uint256"},{name:"maxFee",type:"uint256"},{name:"spec",type:"TransferSpec"}] }, primaryType: "BurnIntent", message: burn }) };
// Byte-encoded TransferSpec hash (replay id used by GatewayMinter.isTransferSpecHashUsed), hookData empty
const specBytes = "0xca85def7" + [1,26,26].map(n=>n.toString(16).padStart(8,"0")).join("") + [spec.sourceContract,spec.destinationContract,spec.sourceToken,spec.destinationToken,spec.sourceDepositor,spec.destinationRecipient,spec.sourceSigner,spec.destinationCaller].map(h=>h.slice(2)).join("") + spec.value.toString(16).padStart(64,"0") + spec.salt.slice(2) + "00000000";
out.vectors.gatewayBurnIntent_sameChain.transferSpecBytesLength = (specBytes.length-2)/2;
out.vectors.gatewayBurnIntent_sameChain.transferSpecHash = keccak256(specBytes);
const rec = { paymentRefHash: "0x3333333333333333333333333333333333333333333333333333333333333333", requestCommit: "0x4444444444444444444444444444444444444444444444444444444444444444", responseCommit: "0x5555555555555555555555555555555555555555555555555555555555555555", statusCode: 200, originAsserted: "https://merchant.example", requirementsHashSeen: "0x6666666666666666666666666666666666666666666666666666666666666666", tRequest: 1760790000n, tPaymentSigned: 1760790001n, tComplete: 1760790003n, outcome: 0, localChecksCommit: "0x0000000000000000000000000000000000000000000000000000000000000000", disclosure: 2, createdAt: 1760790004n };
out.vectors.slReceipt_5042002 = { message: rec, digest: hashTypedData({ domain: { name: "SelectionLayer", version: "1", chainId: 5042002 }, types: { Receipt: [["paymentRefHash","bytes32"],["requestCommit","bytes32"],["responseCommit","bytes32"],["statusCode","uint16"],["originAsserted","string"],["requirementsHashSeen","bytes32"],["tRequest","uint64"],["tPaymentSigned","uint64"],["tComplete","uint64"],["outcome","uint8"],["localChecksCommit","bytes32"],["disclosure","uint8"],["createdAt","uint64"]].map(([name,type])=>({name,type})) }, primaryType: "Receipt", message: rec }) };
// periodId 2963 starts at 2963 * 604800 = 1792022400; the deadline is one hour into that period (RV-061)
const ar = { category: keccak256(toHex("research")), newLimit: 5000000n, periodId: 2963n, nonce: 7n, deadline: 1792026000n };
out.vectors.autonomyRaise_5042002 = { message: ar, digest: hashTypedData({ domain: { name: "CzarVault", version: "1", chainId: 5042002, verifyingContract: VAULT }, types: { AutonomyRaise: [["category","bytes32"],["newLimit","uint256"],["periodId","uint64"],["nonce","uint256"],["deadline","uint256"]].map(([name,type])=>({name,type})) }, primaryType: "AutonomyRaise", message: ar }) };
// ReceiptAttestation over the slReceipt vector's struct hash, bound to the example vault (RV-013)
const receiptStructHash = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,bytes32,uint16,bytes32,bytes32,uint64,uint64,uint64,uint8,bytes32,uint8,uint64"), [th(TYPES.Receipt), rec.paymentRefHash, rec.requestCommit, rec.responseCommit, rec.statusCode, keccak256(toHex(rec.originAsserted)), rec.requirementsHashSeen, rec.tRequest, rec.tPaymentSigned, rec.tComplete, rec.outcome, rec.localChecksCommit, rec.disclosure, rec.createdAt]));
// Cross-check the hand-encoded struct hash against viem's EIP-712 encoder
const viemStructHash = hashStruct({ data: rec, primaryType: "Receipt", types: { Receipt: [["paymentRefHash","bytes32"],["requestCommit","bytes32"],["responseCommit","bytes32"],["statusCode","uint16"],["originAsserted","string"],["requirementsHashSeen","bytes32"],["tRequest","uint64"],["tPaymentSigned","uint64"],["tComplete","uint64"],["outcome","uint8"],["localChecksCommit","bytes32"],["disclosure","uint8"],["createdAt","uint64"]].map(([name,type])=>({name,type})) } });
if (viemStructHash !== receiptStructHash) throw new Error("Receipt struct hash mismatch");
out.vectors.slReceipt_5042002.structHash = receiptStructHash;
const ra = { receiptStructHash };
out.vectors.receiptAttestation_5042002 = { message: ra, vault: VAULT, digest: hashTypedData({ domain: { name: "CzarVault", version: "1", chainId: 5042002, verifyingContract: VAULT }, types: { ReceiptAttestation: [{ name: "receiptStructHash", type: "bytes32" }] }, primaryType: "ReceiptAttestation", message: ra }) };
const oa = { action: 1, payloadHash: "0x7777777777777777777777777777777777777777777777777777777777777777", nonce: 3n, deadline: 1760900000n };
out.vectors.ownerAction_5042002 = { message: oa, digest: hashTypedData({ domain: { name: "CzarVault", version: "1", chainId: 5042002, verifyingContract: VAULT }, types: { OwnerAction: [["action","uint8"],["payloadHash","bytes32"],["nonce","uint256"],["deadline","uint256"]].map(([name,type])=>({name,type})) }, primaryType: "OwnerAction", message: oa }) };
// BriefRequest example (RV-025): jobKey = keccak256(abi.encode(jobEscrow, jobId)) for Circle's testnet escrow and job 42
const briefJobKey = keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), ["0x0747EEf0706327138c69792bF28Cd525089e4583", 42n]));
const br = { jobKey: briefJobKey, issuedAt: 1792026000n };
out.vectors.briefRequest_5042002 = { message: br, digest: hashTypedData({ domain: { name: "CzarJobBrief", version: "1", chainId: 5042002 }, types: { BriefRequest: [{ name: "jobKey", type: "bytes32" }, { name: "issuedAt", type: "uint64" }] }, primaryType: "BriefRequest", message: br }) };
// Derived nonce example (spec 02 §7): keccak256(abi.encode(NONCE_TAG, vault, reservationId, index))
const NONCE_TAG = keccak256(toHex("czar.vault.nonce.v1"));
out.vectors.derivedNonce_example = { nonceTag: NONCE_TAG, vault: VAULT, reservationId: 12n, index: 3, nonce: keccak256(encodeAbiParameters(parseAbiParameters("bytes32,address,uint64,uint32"), [NONCE_TAG, VAULT, 12n, 3])) };
// Vault signature-envelope kind tags
out.vectors.kindTags = { USDC_3009: keccak256(toHex("czar.vault.sig.USDC_3009.v1")), GATEWAY_BURN: keccak256(toHex("czar.vault.sig.GATEWAY_BURN.v1")), SL_RECEIPT: keccak256(toHex("czar.vault.sig.SL_RECEIPT.v2")), SL_RECEIPT_v1_retired: keccak256(toHex("czar.vault.sig.SL_RECEIPT.v1")), PAYEE_LEAF: keccak256(toHex("czar.payee-leaf.v1")), EVIDENCE_LEAF: keccak256(toHex("czar.evidence-leaf.v1")) };
console.log(JSON.stringify(out, (k,v)=> typeof v === "bigint" ? v.toString() : v, 2));
