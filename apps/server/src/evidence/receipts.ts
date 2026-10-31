import { NO_RESPONSE_COMMIT, paymentRefHash, type SlReceipt } from "@czar/hashing";
import type { Config } from "@czar/config";
import type { PaymentRef, Receipt } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import type { Signer, SignRequest } from "@czar/signer";
import type { Pool } from "pg";

export interface PaymentReceiptInput {
  readonly state: "settled" | "unpaid" | "released";
  readonly payment: PaymentRef;
  readonly reportHashes: readonly string[];
  readonly profileId?: string;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly obsId: string;
  readonly reporterId: string;
  readonly originAsserted: string;
  readonly requestSize: number;
  readonly responseSize: number;
  readonly mimeType: string;
  readonly outcome: Receipt["outcome"];
  readonly disclosure: Receipt["disclosure"];
  readonly attestation: Omit<SlReceipt, "paymentRefHash">;
  readonly bodyRef?: string;
  /** Exact USDC transfer transaction used only for verification; not part of the signed PaymentRef. */
  readonly verifiedTransferTx?: string;
}

export interface PaymentReceiptDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly settlement: { isSettled(payment: PaymentRef): Promise<boolean> };
  readonly now: () => Date;
}

export interface SignedPaymentReceipt {
  readonly paymentRef: PaymentRef;
  readonly receipt: Receipt;
}

export async function createPaymentReceipt(
  input: PaymentReceiptInput,
  dependencies: PaymentReceiptDependencies,
): Promise<SignedPaymentReceipt | null> {
  if (input.state !== "settled") return null;
  if (
    input.outcome === "no-response" &&
    (input.attestation.responseCommit !== NO_RESPONSE_COMMIT ||
      input.attestation.statusCode !== 0 ||
      input.responseSize !== 0 ||
      input.mimeType !== "" ||
      input.bodyRef !== undefined)
  )
    throw new TypeError("No-response receipt must use the fixed sentinel and no HTTP metadata.");
  if (input.payment.rail !== "x402-exact")
    throw new Error("Vault receipt requires an x402-exact PaymentRef.");
  const transferTx = input.payment.settlementTx ?? input.verifiedTransferTx;
  if (!transferTx || !/^0x[\da-fA-F]{64}$/.test(transferTx))
    throw new Error("Vault receipt requires a settled x402-exact PaymentRef with a transaction.");
  const paymentHash = paymentRefHash(input.payment);
  const stored = await readStoredReceipt(dependencies.pool, input, paymentHash);
  if (stored) return stored;
  const proofPayment = { ...input.payment, settlementTx: transferTx };
  if (!(await dependencies.settlement.isSettled(proofPayment))) return null;
  const payment = { ...input.payment } as PaymentRef;
  const createdAt = dependencies.now();
  const receiptData = receiptFields(input, payment, paymentHash, createdAt);
  const attestation = { ...input.attestation, paymentRefHash: paymentHash };
  const signed = await signerWithTimeout(dependencies, {
    caller: "cz-15",
    request: {
      keyId: "K3",
      kind: "sl-receipt",
      payload: {
        vault: String(input.payment.payer),
        paymentRef: input.payment,
        receipt: signerReceipt(attestation),
      },
    },
  });
  if (!("signature" in signed)) throw new Error("K3 did not return an SL_RECEIPT signature.");
  const receipt: Receipt = { ...receiptData, sig: signed.signature };
  if (!validateSchema("payment-ref", payment))
    throw new Error("Settled PaymentRef failed schema validation.");
  if (!validateSchema("receipt", receipt))
    throw new Error("Signed Receipt failed schema validation.");
  await persistReceipt(dependencies.pool, input, paymentHash, receipt, createdAt);
  return { paymentRef: payment, receipt };
}

async function readStoredReceipt(
  pool: Pool,
  input: PaymentReceiptInput,
  paymentHash: string,
): Promise<SignedPaymentReceipt | null> {
  const result = await pool.query<{
    payment_ref_hash: string;
    receipt: Receipt;
    report_hashes: string[];
  }>("SELECT payment_ref_hash,receipt,report_hashes FROM evidence_receipts WHERE obs_id=$1", [
    input.obsId,
  ]);
  const stored = result.rows[0];
  if (!stored) return null;
  if (
    stored.payment_ref_hash !== paymentHash ||
    JSON.stringify(stored.report_hashes) !== JSON.stringify(input.reportHashes) ||
    stored.receipt.envelopeRef !== input.envelopeRef ||
    stored.receipt.stepIndex !== input.stepIndex
  )
    throw new Error("Observation id is already bound to another payment or report set.");
  return { paymentRef: stored.receipt.payment, receipt: stored.receipt };
}

async function signerWithTimeout(
  dependencies: PaymentReceiptDependencies,
  input: { readonly caller: string; readonly request: SignRequest },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dependencies.signer.sign(input.caller, input.request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("K3 receipt signing exceeded evidence.receiptSignTimeoutMs.")),
          Number(dependencies.config.get("evidence.receiptSignTimeoutMs")),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function signerReceipt(receipt: SlReceipt): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(receipt).map(([key, value]) => [key, String(value)]));
}

function receiptFields(
  input: PaymentReceiptInput,
  payment: PaymentRef,
  paymentHash: `0x${string}`,
  createdAt: Date,
): Omit<Receipt, "sig"> {
  const timing = input.attestation;
  return {
    schemaVersion: "1.0",
    kind: "receipt",
    reporter: {
      kind: "buyer",
      id: input.reporterId,
      address: String(payment.payer),
    },
    payment,
    payment_ref_hash: paymentHash,
    origin_asserted: input.originAsserted,
    ...(input.attestation.requirementsHashSeen === "0x" + "0".repeat(64)
      ? {}
      : { requirements_hash_seen: input.attestation.requirementsHashSeen }),
    request: {
      commit: timing.requestCommit,
      canonical_scheme: "sl-req-v1",
      size: input.requestSize,
    },
    response: {
      ...(input.outcome === "no-response" ? {} : { status_code: timing.statusCode }),
      commit: timing.responseCommit,
      size: input.responseSize,
      mime: input.mimeType,
    },
    timing: {
      t_request: Number(timing.tRequest),
      t_payment_signed: Number(timing.tPaymentSigned),
      t_complete: Number(timing.tComplete),
    },
    outcome: input.outcome,
    disclosure: input.disclosure,
    ...(input.reportHashes.length > 0
      ? {
          local_checks: {
            profile_id: requiredProfileId(input.profileId),
            checks_commit: timing.localChecksCommit,
          },
        }
      : {}),
    created_at: createdAt.toISOString(),
    obs_id: input.obsId,
    envelopeRef: input.envelopeRef,
    stepIndex: input.stepIndex,
  };
}

function requiredProfileId(profileId: string | undefined): string {
  if (profileId === undefined)
    throw new Error("Acceptance profile is required when reports are attached.");
  return profileId;
}

async function persistReceipt(
  pool: Pool,
  input: PaymentReceiptInput,
  paymentHash: string,
  receipt: Receipt,
  createdAt: Date,
): Promise<void> {
  const reservationId =
    input.payment.rail === "x402-exact" ? input.payment.reservationId : undefined;
  const index = input.payment.rail === "x402-exact" ? input.payment.index : undefined;
  if (reservationId === undefined || index === undefined)
    throw new Error("Vault receipt requires reservationId and authorization index.");
  await pool.query(
    `INSERT INTO evidence_receipts
       (obs_id,envelope_ref,step_index,reservation_id,authorization_index,payment_ref_hash,receipt,report_hashes,created_at,body_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (obs_id) DO NOTHING`,
    [
      input.obsId,
      input.envelopeRef,
      input.stepIndex,
      reservationId,
      index,
      paymentHash,
      JSON.stringify(receipt),
      [...input.reportHashes],
      createdAt,
      input.bodyRef ?? null,
    ],
  );
}
