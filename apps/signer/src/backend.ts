// The pluggable signer backend (D70): `local-keystore` in Phase 1, `gcp-kms` in stage 2. The policy layer
// decides; a backend only holds keys and signs what it is handed.
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import type { Address, Hash32 } from "@czar/hashing";
import type { KeyId } from "./kinds.ts";

export type BackendName = "local-keystore" | "gcp-kms";

export interface SignerBackend {
  readonly name: BackendName;
  /** Key references held: `K3`, `K5`, …, `relayer`, and `K4:<pocket>` per pocket. */
  keyRefs(): string[];
  address(keyRef: string): Address | undefined;
  /** 65-byte `r ‖ s ‖ v` signature, low s, v ∈ {27, 28}. */
  signDigest(keyRef: string, digest: Hash32): Promise<Hex>;
  signTransaction(keyRef: string, tx: TransactionSerializableEIP1559): Promise<Hex>;
  createKey(keyId: KeyId): Promise<{ keyRef: string; address: Address }>;
  destroyKey(keyRef: string): Promise<void>;
}
