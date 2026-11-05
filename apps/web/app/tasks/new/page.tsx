"use client";

// UX-02 (SCR-181 §6): start a smart contract audit from the browser. The form's checks mirror the server's
// limits; the server checks everything again and builds the objective itself.
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AppApiError, appApi } from "#src/app-api";
import {
  buildTaskRequest,
  TASK_PRIVACY_NOTICE,
  TASK_SOURCE_MAX_CHARS,
  type TaskForm,
} from "#src/tasks";

const EMPTY_FORM: TaskForm = {
  title: "",
  description: "",
  mode: "source",
  source: "",
  address: "",
  maxBudget: "",
};

function startErrorMessage(cause: unknown): string {
  if (cause instanceof AppApiError) {
    if (cause.status === 401) return "Sign in with your passkey first.";
    if (cause.czarCode === "no-vault") return "Create your wallet first.";
    if (cause.czarCode === "device-revoked")
      return "Browser tasks are turned off for this account. Sign in again to turn them back on.";
    if (cause.status === 429)
      return "You have started many tasks in the last hour. Try again later.";
    if (cause.status === 400)
      return "Czar could not accept this task. Check the fields and try again.";
  }
  return "Czar could not start the task. Check the connection and try again.";
}

export default function NewTaskPage() {
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // One idempotency key per version of the form, so a retried click never starts a second task.
  const key = useRef<string | undefined>(undefined);

  function change(next: Partial<TaskForm>) {
    setForm((current) => ({ ...current, ...next }));
    key.current = undefined;
  }
  const field =
    (name: "title" | "description" | "source" | "address" | "maxBudget") =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      change({ [name]: event.target.value });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = buildTaskRequest(form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(undefined);
    setSending(true);
    key.current ??= crypto.randomUUID();
    try {
      const accepted = await appApi.createAppObjective(built.request, key.current);
      window.location.assign(`/tasks/${encodeURIComponent(accepted.objectiveId)}`);
    } catch (cause) {
      setError(startErrorMessage(cause));
      setSending(false);
    }
  }

  return (
    <section className="panel page-stack">
      <h1 className="czar-title">New task</h1>
      <p>
        Describe your smart contract. Czar finds a merchant to audit it and asks you before paying.
      </p>
      <form className="page-stack" noValidate onSubmit={submit}>
        <label>
          Service type
          <select disabled value="smart-contract-audit">
            <option value="smart-contract-audit">Smart contract audit</option>
          </select>
        </label>
        <label>
          Title
          <input name="title" onChange={field("title")} value={form.title} />
        </label>
        <label>
          What should the audit look at?
          <textarea
            name="description"
            onChange={field("description")}
            rows={3}
            value={form.description}
          />
        </label>
        <fieldset>
          <legend>Contract</legend>
          <label>
            <input
              checked={form.mode === "source"}
              name="mode"
              onChange={() => change({ mode: "source" })}
              type="radio"
            />{" "}
            Paste the source
          </label>
          <label>
            <input
              checked={form.mode === "address"}
              name="mode"
              onChange={() => change({ mode: "address" })}
              type="radio"
            />{" "}
            Give a verified contract address
          </label>
        </fieldset>
        {form.mode === "source" ? (
          <label>
            Contract source
            <textarea
              name="source"
              onChange={field("source")}
              rows={12}
              spellCheck={false}
              value={form.source}
            />
            <span aria-live="polite">
              {form.source.length.toLocaleString("en-US")} /{" "}
              {TASK_SOURCE_MAX_CHARS.toLocaleString("en-US")} characters
            </span>
          </label>
        ) : (
          <label>
            Contract address
            <input
              name="address"
              onChange={field("address")}
              placeholder="0x…"
              spellCheck={false}
              value={form.address}
            />
          </label>
        )}
        <label>
          Maximum budget in USDC (optional)
          <input
            inputMode="decimal"
            name="maxBudget"
            onChange={field("maxBudget")}
            placeholder="1.50"
            value={form.maxBudget}
          />
        </label>
        <p className="notice">{TASK_PRIVACY_NOTICE}</p>
        {error && <p role="alert">{error}</p>}
        <button disabled={sending} type="submit">
          {sending ? "Starting…" : "Start task"}
        </button>
      </form>
    </section>
  );
}
