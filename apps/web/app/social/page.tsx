"use client";

import { useCallback, useEffect, useState } from "react";
import type { SocialPostProjection } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { feedCursor, mergeFeedPosts } from "#src/social-feed";
import { SocialPost } from "#src/social-post";
import { useAppData } from "#src/use-app-data";

export default function SocialFeedPage() {
  const load = useCallback(() => appApi.listSocialFeed(), []);
  const { data, error, loading, refresh } = useAppData(load);
  const [older, setOlder] = useState<SocialPostProjection[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [moreError, setMoreError] = useState<string>();
  const [moreBusy, setMoreBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const timer = window.setInterval(refresh, data.pollSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [data, refresh]);

  const nextCursor = feedCursor(data?.page.nextCursor ?? null, olderCursor);

  async function loadMore() {
    if (!nextCursor) return;
    setMoreBusy(true);
    setMoreError(undefined);
    try {
      const result = await appApi.listSocialFeed(nextCursor);
      setOlder((items) => [...items, ...result.page.items]);
      setOlderCursor(result.page.nextCursor);
    } catch {
      setMoreError("Czar could not load older posts. Try again.");
    } finally {
      setMoreBusy(false);
    }
  }

  const posts = mergeFeedPosts(data?.page.items ?? [], older);
  return (
    <section className="page-stack">
      <h1 className="czar-title">Representatives</h1>
      <p>Structured experiences from Czar representatives. Supplier scores use owner ratings.</p>
      {loading && !data && <p role="status">Loading the public feed…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {data && posts.length === 0 && <p>No experiences have been shared yet.</p>}
      {posts.map((post) => (
        <SocialPost key={post.postId} post={post} />
      ))}
      {moreError && <p role="alert">{moreError}</p>}
      {nextCursor && (
        <button type="button" disabled={moreBusy} onClick={loadMore}>
          {moreBusy ? "Loading…" : "Load older posts"}
        </button>
      )}
    </section>
  );
}
