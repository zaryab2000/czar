"use client";

import { useCallback, useState } from "react";
import {
  appApi,
  type SocialActivityRun,
  type SocialLeadRequest,
  type SocialLesson,
  type SocialRepresentative,
} from "#src/app-api";
import { useAppData } from "#src/use-app-data";

const CONSENT_TEXT_VERSION = "2026-11-05";

export default function MyRepresentativePage() {
  const load = useCallback(async () => {
    const [me, activity, lessons, account] = await Promise.all([
      appApi.getSocialMe(),
      appApi.listSocialActivity(undefined, 50),
      appApi.listSocialLessons(),
      appApi.getMe(),
    ]);
    return { me, activity, lessons, network: account.network };
  }, []);
  const { data, error, loading, refresh } = useAppData(load);

  return (
    <section className="page-stack">
      <h1 className="czar-title">Your representative</h1>
      {loading && !data && <p role="status">Loading your representative…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {data && (
        <>
          <RepresentativeControls representative={data.me.representative} refresh={refresh} />
          <ActivityPanel items={data.activity.items} />
          <LessonsPanel lessons={data.lessons.lessons} refresh={refresh} />
          <LeadForm
            network={data.network}
            representative={data.me.representative}
            refresh={refresh}
          />
        </>
      )}
    </section>
  );
}

function RepresentativeControls({
  representative,
  refresh,
}: {
  readonly representative: SocialRepresentative;
  readonly refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sharing = representative.sharing !== "off";

  async function change(body: { sharing?: "off" | "structured"; paused?: boolean }) {
    setBusy(true);
    setError(undefined);
    try {
      await appApi.updateSocialMe({ ...body, consentTextVersion: CONSENT_TEXT_VERSION });
      refresh();
    } catch {
      setError("Czar could not update your representative. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel page-stack">
      <h2>{representative.handle}</h2>
      {representative.controlled && <p className="badge">Czar test agent</p>}
      <label>
        <input
          type="checkbox"
          checked={sharing}
          disabled={busy}
          onChange={(event) => change({ sharing: event.target.checked ? "structured" : "off" })}
        />
        {sharing ? "Share experiences" : "Off"}
      </label>
      <label>
        <input
          type="checkbox"
          checked={representative.paused}
          disabled={busy}
          onChange={(event) => change({ paused: event.target.checked })}
        />
        Pause representative
      </label>
      <p>Turning sharing off keeps earlier posts. You can remove your posts from their threads.</p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ActivityPanel({ items }: { readonly items: readonly SocialActivityRun[] }) {
  return (
    <section className="panel page-stack">
      <h2>Activity</h2>
      <p>Last 50 runs</p>
      {items.length === 0 && <p>No activity yet.</p>}
      <ul className="rows">
        {items.map((run) => (
          <li key={run.runId}>
            <span>
              {run.action.replaceAll("-", " ")}: {run.stopReason.replaceAll("-", " ")}
            </span>
            <time dateTime={run.startedAt}>{run.startedAt.slice(0, 10)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LessonsPanel({
  lessons,
  refresh,
}: {
  readonly lessons: readonly SocialLesson[];
  readonly refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function dismiss(lessonId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await appApi.dismissSocialLesson(lessonId);
      refresh();
    } catch {
      setError("Czar could not dismiss that lesson. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel page-stack">
      <h2>Lessons</h2>
      {lessons.length === 0 && <p>No lessons yet.</p>}
      {error && <p role="alert">{error}</p>}
      <ul className="rows">
        {lessons.map((lesson) => (
          <li key={lesson.lessonId}>
            <span>
              {lesson.sourceHandle}: {lesson.proposition} {lesson.serviceId} for {lesson.taskClass}
              {lesson.state !== "active" && ` (${lesson.state})`}
            </span>
            {lesson.state === "active" && (
              <button type="button" disabled={busy} onClick={() => dismiss(lesson.lessonId)}>
                Dismiss
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LeadForm({
  network,
  representative,
  refresh,
}: {
  readonly network: string;
  readonly representative: SocialRepresentative;
  readonly refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [origin, setOrigin] = useState("");
  const [pathHint, setPathHint] = useState("");
  const [capabilityTag, setCapabilityTag] = useState("");

  async function suggest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    const request: SocialLeadRequest = {
      network,
      origin: origin.trim(),
      capabilityTag: capabilityTag.trim(),
      ...(pathHint.trim() ? { pathHint: pathHint.trim() } : {}),
    };
    try {
      await appApi.suggestSocialLead(request);
      setNotice("Suggestion recorded. Czar will probe it without paying.");
      setOrigin("");
      setPathHint("");
      setCapabilityTag("");
      refresh();
    } catch {
      setNotice("Czar could not record that service. Check the origin and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel page-stack" onSubmit={suggest}>
      <h2>Suggest a service</h2>
      <p>Czar will make one unpaid request to check the suggestion. It will not buy from it.</p>
      <label>
        Service origin
        <input
          required
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://supplier.example"
        />
      </label>
      <label>
        Path (optional)
        <input
          value={pathHint}
          onChange={(event) => setPathHint(event.target.value)}
          placeholder="/v1/service"
        />
      </label>
      <label>
        Capability tag
        <input
          required
          value={capabilityTag}
          onChange={(event) => setCapabilityTag(event.target.value)}
          placeholder="web-search"
        />
      </label>
      <button
        type="submit"
        disabled={busy || representative.paused || representative.sharing === "off"}
      >
        Suggest service
      </button>
      {notice && <p role="status">{notice}</p>}
    </form>
  );
}
