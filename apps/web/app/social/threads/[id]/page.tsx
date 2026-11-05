"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { appApi, hasAppSession } from "#src/app-api";
import { SocialPost } from "#src/social-post";
import { useAppData } from "#src/use-app-data";

export default function SocialThreadPage() {
  const params = useParams<{ id: string }>();
  const threadId = params.id;
  const load = useCallback(() => appApi.getSocialThread(threadId), [threadId]);
  const { data, error, loading, refresh } = useAppData(load);
  const [representativeId, setRepresentativeId] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    if (!hasAppSession()) return;
    let active = true;
    void appApi.getSocialMe().then(
      (me) => {
        if (active) setRepresentativeId(me.representative.representativeId);
      },
      () => {
        if (active) setRepresentativeId(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function deleteOwnPost(postId: string) {
    if (!window.confirm("Remove this post? Its place in the thread will remain visible.")) return;
    setDeleteError(undefined);
    try {
      await appApi.deleteSocialPost(postId);
      refresh();
    } catch {
      setDeleteError("Czar could not remove your post. Try again.");
    }
  }

  const thread = data?.thread;
  return (
    <section className="page-stack">
      <a href="/social">← Public feed</a>
      {loading && !data && <p role="status">Loading thread…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {thread && (
        <>
          <header className="panel page-stack">
            <p className="eyebrow">
              {thread.kind} thread · {thread.state}
            </p>
            <h1 className="czar-title">{thread.serviceId ?? thread.capabilityTag ?? "Question"}</h1>
            {thread.taskClass && <p>Task class: {thread.taskClass}</p>}
            {thread.versionId && <p>Version: {thread.versionId}</p>}
            <p>
              {thread.network} · {thread.createdAt.slice(0, 10)}
            </p>
          </header>
          {data.incident && (
            <aside className="notice" role="status">
              Incident {data.incident.state}: {data.incident.distinctOwners} owners,{" "}
              {data.incident.negativeUnits} bad outcomes on record.
            </aside>
          )}
          <h2>Posts</h2>
          {data.posts.length === 0 && <p>No posts in this thread yet.</p>}
          {deleteError && <p role="alert">{deleteError}</p>}
          {data.posts.map((post) => (
            <SocialPost
              key={post.postId}
              post={post}
              currentRepresentativeId={representativeId}
              onDelete={deleteOwnPost}
            />
          ))}
        </>
      )}
    </section>
  );
}
