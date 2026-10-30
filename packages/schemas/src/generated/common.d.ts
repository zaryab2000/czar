// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * USDC atomic units, 6 decimals, decimal integer string. Never a float, never 18-decimal native wei.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Amount6".
 */
export type Amount6 = string;
/**
 * Basis points; math floors.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Bps".
 */
export type Bps = number;
/**
 * EIP-55 checksummed address in APIs; lowercase inside canonical JSON for hashing.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Address".
 */
export type Address = string;
/**
 * 32-byte keccak256 hash, lowercase hex with 0x.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Hash32".
 */
export type Hash32 = string;
/**
 * Arbitrary byte string, lowercase hex with 0x.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Hex".
 */
export type Hex = string;
/**
 * CAIP-2 chain id, e.g. eip155:5042002.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Caip2".
 */
export type Caip2 = string;
/**
 * CAIP-10 account id with lowercase address.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Caip10".
 */
export type Caip10 = string;
/**
 * RFC 3339 UTC with millisecond precision and Z suffix.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * Unix time in seconds (on-chain uint64).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "UnixSeconds".
 */
export type UnixSeconds = number;
/**
 * 26-character Crockford base32 ULID.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Ulid".
 */
export type Ulid = string;
/**
 * ActivityEvent id.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "EventId".
 */
export type EventId = string;
/**
 * Soul belief id.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "BeliefId".
 */
export type BeliefId = string;
/**
 * Soul source receipt id (D90): interview answer, selected file, git item, paste or agent summary.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SourceReceiptId".
 */
export type SourceReceiptId = string;
/**
 * Proposed belief id (D90); local only.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "ProposalId".
 */
export type ProposalId = string;
/**
 * Soul source scan id (D90); local only.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SourceScanId".
 */
export type SourceScanId = string;
/**
 * Local consent record id for a source scope (D90).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "ConsentId".
 */
export type ConsentId = string;
/**
 * A belief receipt (D90): an ActivityEvent id (observed) or a SourceReceipt id (declared, local-file, imported). The prefix names the type.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "ReceiptRef".
 */
export type ReceiptRef = EventId | SourceReceiptId;
/**
 * Work Soul section name (spec 02 §4.2).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SoulSection".
 */
export type SoulSection =
  "place" | "mission" | "rituals" | "friction" | "drives" | "taste" | "constraints" | "spendingPosture";
/**
 * Where a belief or receipt came from (D90).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SourceClass".
 */
export type SourceClass = "observed" | "declared" | "local-file" | "imported";
/**
 * Objective id, minted by the daemon.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "ObjectiveId".
 */
export type ObjectiveId = string;
/**
 * Plan id, minted by the server.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "PlanId".
 */
export type PlanId = string;
/**
 * Step id, minted by the server.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "StepId".
 */
export type StepId = string;
/**
 * Device id, minted at pairing.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "DeviceId".
 */
export type DeviceId = string;
/**
 * Evidence batch id.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "BatchId".
 */
export type BatchId = string;
/**
 * x402 payment-identifier id (spec 02 §7.4; F1-06).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "PaymentId".
 */
export type PaymentId = string;
/**
 * Caip10(vault) + ':' + envelopeId.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "EnvelopeRef".
 */
export type EnvelopeRef = string;
/**
 * Unsigned 64-bit integer.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Uint64".
 */
export type Uint64 = number;
/**
 * uint256 as a decimal string.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Uint256String".
 */
export type Uint256String = string;
/**
 * Spending category, lowercase kebab-case.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "Category".
 */
export type Category = string;
/**
 * Capability tag, lowercase kebab-case, e.g. web-search.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "CapabilityTag".
 */
export type CapabilityTag = string;
/**
 * Selection Layer ServiceId (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlServiceId".
 */
export type SlServiceId = string;
/**
 * Selection Layer ProfileId (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlProfileId".
 */
export type SlProfileId = string;
/**
 * Selection Layer ObsId (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlObsId".
 */
export type SlObsId = string;
/**
 * Selection Layer ReportId (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlReportId".
 */
export type SlReportId = string;
/**
 * Selection Layer VersionId (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlVersionId".
 */
export type SlVersionId = string;
/**
 * Selection Layer PolicyVersion (SL §5.1).
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "SlPolicyVersion".
 */
export type SlPolicyVersion = string;
/**
 * Rating id (SCR-160), minted by the server.
 *
 * This interface was referenced by `Common`'s JSON-Schema
 * via the `definition` "RatingId".
 */
export type RatingId = string;

/**
 * Shared primitive formats referenced by every Czar schema (spec 02 §2.1).
 */
export interface Common {
  [k: string]: unknown;
}
