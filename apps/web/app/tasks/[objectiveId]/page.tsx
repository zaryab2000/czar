"use client";

// UX-03 and UX-04 (SCR-181 §6): a task's progress in plain words, polled every app.objectivePollSeconds
// until it ends. Waiting for approval links to the approval page; a delivered task shows its result card,
// where the owner rates it Good or Bad.
import { useParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { appApi } from "#src/app-api";
import { ResultCard } from "#src/result-card";
import { isTaskFinished, TASK_POLL_MS, taskStateLabel } from "#src/tasks";
import { useAppData } from "#src/use-app-data";

export default function TaskProgressPage() {
  const { objectiveId } = useParams<{ objectiveId: string }>();
  const load = useCallback(() => appApi.getAppObjective(objectiveId), [objectiveId]);
  const { data: task, error, loading, refresh } = useAppData(load);
  const finished = task !== undefined && isTaskFinished(task.state);

  useEffect(() => {
    if (finished) return undefined;
    const timer = setInterval(refresh, TASK_POLL_MS);
    return () => clearInterval(timer);
  }, [finished, refresh]);

  if (loading && !task) return <p role="status">Loading your task…</p>;
  if (!task)
    return (
      <section className="panel page-stack">
        <p role="alert">{error ?? "Czar could not find this task."}</p>
        <a href="/home">Back to your account</a>
      </section>
    );

  return (
    <section aria-label="Task progress" className="panel page-stack">
      <p className="eyebrow">{task.origin === "web" ? "Web" : "Device"} task</p>
      <h1 className="czar-title">{task.title === "" ? "Untitled task" : task.title}</h1>
      <p aria-live="polite" role="status">
        {taskStateLabel(task.state)}
      </p>
      {task.state === "awaiting-approval" && task.planId && (
        <a className="primary-link" href={`/approve/${encodeURIComponent(task.planId)}`}>
          Review and approve
        </a>
      )}
      {task.state === "delivered" && <DeliveredResult objectiveId={task.objectiveId} />}
      <a href="/home">Back to your account</a>
    </section>
  );
}

function DeliveredResult({ objectiveId }: { readonly objectiveId: string }) {
  const load = useCallback(() => appApi.listAllAppResults(), []);
  const { data, error, loading } = useAppData(load);
  const card = data?.items.find((item) => item.objectiveId === objectiveId);
  if (loading && !data) return <p role="status">Loading the result…</p>;
  if (error && !data) return <p role="alert">{error}</p>;
  if (!card) return <p>The result is being prepared. Check back in a moment.</p>;
  return <ResultCard card={card} />;
}
