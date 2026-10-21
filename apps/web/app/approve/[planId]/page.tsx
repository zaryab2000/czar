"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AppPlan, Me, SubjectsRevision } from "@czar/schemas";
import { AppApiError, appApi } from "#src/app-api";
import { assertApprovalIntent, PLAN_MISMATCH_MESSAGE } from "#src/approval-integrity";
import { useAppData } from "#src/use-app-data";
import { getStoredPasskey, readEnvelopeCount, sendOwnerUserOperation } from "#src/wallet";
import { formatUsd } from "@czar/web/money-format";

export default function ApprovalPage() {
  const { planId } = useParams<{ planId: string }>();
  const load = useCallback(() => appApi.getApproval(planId), [planId]);
  const { data: plan, error, loading, refresh } = useAppData(load);
  if (loading && !plan) return <p role="status">Loading this plan…</p>;
  if (!plan)
    return <LoadError message={error ?? "This plan could not be loaded."} retry={refresh} />;
  return <ApprovalReview plan={plan} error={error} refresh={refresh} />;
}

function ApprovalReview({
  plan,
  error,
  refresh,
}: {
  readonly plan: AppPlan;
  readonly error: string | undefined;
  readonly refresh: () => void;
}) {
  const [currentPlan, setCurrentPlan] = useState(plan);
  const loadMe = useCallback(() => appApi.getMe(), []);
  const { data: me } = useAppData(loadMe);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [fillInPlace, setFillInPlace] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  useEffect(() => {
    setCurrentPlan(plan);
  }, [plan]);

  useEffect(() => {
    setSubjects(currentPlan.taskSpec?.subjects.map((subject) => subject.label) ?? []);
  }, [currentPlan]);

  return (
    <section className="page-stack">
      <h1 className="czar-title">Review this plan</h1>
      {error && <LoadError message={error} retry={refresh} />}
      <GoalPanel plan={currentPlan} />
      {me && <CapWarning me={me} plan={currentPlan} />}
      {currentPlan.taskSpec && (
        <SubjectEditor
          plan={currentPlan}
          subjects={subjects}
          fillInPlace={fillInPlace}
          busy={busy}
          setSubjects={setSubjects}
          setFillInPlace={setFillInPlace}
          setBusy={setBusy}
          setNotice={setNotice}
          onRevised={setCurrentPlan}
        />
      )}
      <StepsPanel plan={currentPlan} />
      {currentPlan.marketReference && <MarketPanel plan={currentPlan} />}
      <p>This plan expires {currentPlan.expiresAt}</p>
      {notice && <p role="status">{notice}</p>}
      {!declined && (
        <>
          <ApproveButton
            plan={currentPlan}
            me={me}
            fillInPlace={fillInPlace}
            busy={busy}
            setBusy={setBusy}
            setNotice={setNotice}
          />
          <button
            disabled={busy}
            onClick={() => {
              setDeclined(true);
              setNotice("Declined. Czar won't spend on this.");
            }}
            type="button"
          >
            Decline
          </button>
        </>
      )}
    </section>
  );
}

function CapWarning({ me, plan }: { readonly me: Me; readonly plan: AppPlan }) {
  const userMax = me.limits.find((limit) => limit.category === plan.category)?.userMax;
  const thresholdBps = Number(process.env["NEXT_PUBLIC_CZAR_LARGE_CAP_WARN_BPS"] ?? "5000");
  if (!userMax || !Number.isSafeInteger(thresholdBps) || thresholdBps < 1) return null;
  if (BigInt(plan.cap) * 10_000n <= BigInt(userMax) * BigInt(thresholdBps)) return null;
  return (
    <p className="notice">This plan uses a large share of your weekly {plan.category} maximum.</p>
  );
}

function GoalPanel({ plan }: { readonly plan: AppPlan }) {
  return (
    <section className="panel">
      <h2>Goal</h2>
      <p>
        Spend up to {formatUsd(plan.cap)} ({plan.cap} USDC) on “
        {plan.taskSpec?.topic ?? "your task"}”
      </p>
    </section>
  );
}

function SubjectEditor({
  plan,
  subjects,
  fillInPlace,
  busy,
  setSubjects,
  setFillInPlace,
  setBusy,
  setNotice,
  onRevised,
}: {
  readonly plan: AppPlan;
  readonly subjects: string[];
  readonly fillInPlace: boolean;
  readonly busy: boolean;
  readonly setSubjects: (subjects: string[]) => void;
  readonly setFillInPlace: (checked: boolean) => void;
  readonly setBusy: (busy: boolean) => void;
  readonly setNotice: (message: string | undefined) => void;
  readonly onRevised: (plan: AppPlan) => void;
}) {
  const taskSpec = plan.taskSpec;
  if (!taskSpec) return null;
  const originalSubjects = taskSpec.subjects;

  async function updateSubjects() {
    setBusy(true);
    setNotice(undefined);
    try {
      const body = createSubjectsRevision(originalSubjects, subjects);
      const revised = await appApi.revisePlanSubjects(plan.planId, body);
      onRevised(revised);
      setNotice(`List updated. New estimate: ${formatUsd(revised.cap)}.`);
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel page-stack">
      <h2>What Czar will look up</h2>
      <p>
        Czar will look up {taskSpec.fields.join(", ")} for:{" "}
        {taskSpec.subjects.map((subject) => subject.label).join(", ")}.
      </p>
      {taskSpec.subjects.map((subject) => (
        <p key={`${subject.label}-${subject.sourceLine ?? "none"}`}>
          {subject.sourceLine === undefined
            ? ""
            : `From ${taskSpec.fileName ?? "your file"}, ${taskSpec.topic}`}
        </p>
      ))}
      <label htmlFor="subjects">Edit list</label>
      <textarea
        id="subjects"
        rows={Math.min(Math.max(subjects.length, 2), 8)}
        value={subjects.join("\n")}
        onChange={(event) => setSubjects(event.target.value.split("\n"))}
      />
      <button disabled={busy} onClick={updateSubjects} type="button">
        Update list
      </button>
      {taskSpec.fileName && (
        <label>
          <input
            checked={fillInPlace}
            onChange={(event) => setFillInPlace(event.target.checked)}
            type="checkbox"
          />
          Fill {taskSpec.fileName} when done
        </label>
      )}
      {taskSpec.output && <p>Result as: {taskSpec.output.format}</p>}
    </section>
  );
}

function createSubjectsRevision(
  existing: NonNullable<AppPlan["taskSpec"]>["subjects"],
  labels: readonly string[],
): SubjectsRevision {
  return {
    subjects: labels.map((label, index) => {
      const prior = existing[index];
      if (prior?.label === label) return { ...prior };
      return { label, addedByUser: true };
    }),
  };
}

function StepsPanel({ plan }: { readonly plan: AppPlan }) {
  return (
    <section className="panel page-stack">
      <h2>Steps and payees</h2>
      {plan.steps.map((step) => (
        <article key={step.stepIndex} className="step-card">
          <h3>
            Step {step.stepIndex + 1}: {step.capability}
          </h3>
          <p>
            Up to {formatUsd(step.stepCap)} ({step.stepCap} USDC)
          </p>
          <p>{railDescription(step.kind)}</p>
          {step.why && (
            <p>
              Fills: {step.why.fills.join(", ")}. {step.why.summary}
            </p>
          )}
          <p>
            Payee: {hostFor(step.resource?.url) ?? step.payee ?? "No paid provider"}
            {step.payee ? ` (${step.payee})` : ""}
          </p>
          {step.alternates && step.alternates.length > 0 && (
            <p>
              If a service fails, Czar may use up to 2 backup services under the same step limit.
            </p>
          )}
          {step.alternates?.map((alternate) => (
            <p key={alternate}>Backup payee: {alternate}</p>
          ))}
          {step.contextNotice === "task-description-only" && (
            <p>
              This job gets only the task description and up to 2,000 characters of context, no
              files.
            </p>
          )}
          {step.why?.alternativesLost.map((alternate) => (
            <p key={alternate.serviceId}>
              {alternate.serviceId} not chosen: {alternativeReason(alternate.reason)}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}

function MarketPanel({ plan }: { readonly plan: AppPlan }) {
  const market = plan.marketReference;
  if (!market) return null;
  return (
    <section className="panel">
      <h2>Real market (Arc mainnet)</h2>
      {market.perCapability.map((item) => (
        <p key={item.capability}>
          {item.ready} listed services do this from {item.low ?? "an unreported price"} per call.{" "}
          Czar has not paid or checked them.
        </p>
      ))}
    </section>
  );
}

function ApproveButton({
  plan,
  me,
  fillInPlace,
  busy,
  setBusy,
  setNotice,
}: {
  readonly plan: AppPlan;
  readonly me: Me | undefined;
  readonly fillInPlace: boolean;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly setNotice: (message: string | undefined) => void;
}) {
  const [pending, setPending] = useState<{
    readonly vault: `0x${string}`;
    readonly expectedEnvelopeId: bigint;
    readonly planHash: string;
    readonly calldata: `0x${string}`;
  }>();
  const insufficientBalance = me !== undefined && BigInt(plan.cap) > BigInt(me.balances.free);
  const blocked = me?.frozen === true || me?.paused === true || insufficientBalance;

  async function prepareApproval() {
    setBusy(true);
    setNotice(undefined);
    try {
      const intent = await appApi.createApprovalIntent(plan.planId, { fillInPlace });
      assertApprovalIntent(plan, intent);
      const previousEnvelopeCount = await readEnvelopeCount(intent.vault);
      const { userOpHash, bundler } = await sendOwnerUserOperation(
        getStoredPasskey(),
        intent.to,
        intent.calldata,
      );
      await appApi.notifySubmitted(plan.planId, { userOpHash, bundler });
      const confirmation = {
        vault: intent.vault,
        expectedEnvelopeId: previousEnvelopeCount + 1n,
        planHash: plan.planHash,
        calldata: intent.calldata,
      };
      setPending(confirmation);
      setNotice("Approved, waiting for the network");
      const timing = await appApi.listPendingApprovals();
      const opened = await waitForEnvelope(
        confirmation,
        timing.pollSeconds,
        timing.confirmTimeoutSeconds,
      );
      if (opened) setNotice("Envelope opened. Czar is working on it.");
      else setNotice("Still waiting for EnvelopeOpened to sync.");
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!pending) return;
    setBusy(true);
    setNotice("Checking for EnvelopeOpened…");
    try {
      const timing = await appApi.listPendingApprovals();
      const opened = await waitForEnvelope(
        pending,
        timing.pollSeconds,
        timing.confirmTimeoutSeconds,
      );
      setNotice(
        opened
          ? "Envelope opened. Czar is working on it."
          : "Still waiting for EnvelopeOpened to sync.",
      );
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resubmit() {
    if (!pending) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const currentCount = await readEnvelopeCount(pending.vault);
      if (currentCount >= pending.expectedEnvelopeId) {
        setNotice("The vault already opened this envelope. Waiting for the indexer to sync.");
        return;
      }
      await sendOwnerUserOperation(getStoredPasskey(), pending.vault, pending.calldata);
      setNotice("Approval resubmitted. Waiting for the network.");
      const timing = await appApi.listPendingApprovals();
      const opened = await waitForEnvelope(
        pending,
        timing.pollSeconds,
        timing.confirmTimeoutSeconds,
      );
      if (opened) setNotice("Envelope opened. Czar is working on it.");
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      {insufficientBalance && (
        <p role="alert">Not enough available money for this plan. Add money or lower the plan.</p>
      )}
      <button
        className="primary-button"
        disabled={busy || pending !== undefined || blocked}
        onClick={prepareApproval}
        type="button"
      >
        {busy ? "Checking plan…" : `Approve ${formatUsd(plan.cap)}`}
      </button>
      {pending && (
        <div role="group" aria-label="Envelope confirmation">
          <button disabled={busy} onClick={checkAgain} type="button">
            Check again
          </button>
          <button disabled={busy} onClick={resubmit} type="button">
            Resubmit
          </button>
        </div>
      )}
    </div>
  );
}

async function waitForEnvelope(
  pending: {
    readonly vault: `0x${string}`;
    readonly expectedEnvelopeId: bigint;
    readonly planHash: string;
    readonly calldata: `0x${string}`;
  },
  pollSeconds: number,
  timeoutSeconds: number,
): Promise<boolean> {
  const envelopeRef = `eip155:5042002:${pending.vault.toLowerCase()}:${pending.expectedEnvelopeId}`;
  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    try {
      const detail = await appApi.getEnvelope(envelopeRef);
      if (detail.envelope.planHash.toLowerCase() === pending.planHash.toLowerCase()) return true;
    } catch (cause) {
      if (!(cause instanceof AppApiError) || cause.status !== 404) throw cause;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => window.setTimeout(resolve, pollSeconds * 1000));
  } while (Date.now() < deadline);
  return false;
}

function railDescription(kind: AppPlan["steps"][number]["kind"]): string {
  if (kind === "x402-exact" || kind === "gateway-nano")
    return "Paid per call, checked before the next step";
  if (kind === "erc8183-job") return "Held in escrow, money back if rejected";
  return "No payment for this step";
}

function alternativeReason(
  reason: NonNullable<AppPlan["steps"][number]["why"]>["alternativesLost"][number]["reason"],
): string {
  switch (reason) {
    case "lower-score":
      return "weaker checked record";
    case "price-over-budget":
      return "costs more than this step allows";
    case "unverified":
      return "not enough checked calls yet";
    case "network":
      return "not payable on this network";
    case "rail":
      return "payment path not supported";
    case "output-format":
      return "can't return the requested format";
    case "probe-failed":
      return "did not answer a price check";
    case "payee-changed":
      return "payee changed since listing";
    case "not-in-top-k":
      return "ranked lower";
  }
}

function hostFor(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof AppApiError) {
    if (cause.czarCode === "plan-expired")
      return "This plan expired. Czar will re-price it if the need is still open.";
    if (cause.czarCode === "frozen") return "Frozen. No payments can start until you unfreeze.";
    if (cause.czarCode === "paused")
      return "Czar paused all spending for safety. Nothing can start.";
    if (cause.czarCode === "session-expired")
      return "Your session expired. Sign in with your passkey.";
    if (cause.czarCode === "validation") return PLAN_MISMATCH_MESSAGE;
    if (cause.czarCode === "insufficient-free-balance")
      return "Not enough available money for this plan. Add money or lower the plan.";
  }
  return cause instanceof Error ? cause.message : "Czar could not prepare this approval.";
}

function LoadError({ message, retry }: { readonly message: string; readonly retry: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <p>{message}</p>
      <button onClick={retry} type="button">
        Try again
      </button>
    </div>
  );
}
