/** Newest polled posts first, then older pages, each post once (the polled copy wins). */
export function mergeFeedPosts<T extends { readonly postId: string }>(
  polled: readonly T[],
  older: readonly T[],
): T[] {
  const seen = new Set(polled.map((item) => item.postId));
  return [...polled, ...older.filter((item) => !seen.has(item.postId))];
}

/**
 * The cursor for "Load older posts": the first page's until an older page is loaded,
 * then the last older page's, so a background poll never resets the reader's place.
 */
export function feedCursor(
  firstPageCursor: string | null,
  olderCursor: string | null | undefined,
): string | null {
  return olderCursor === undefined ? firstPageCursor : olderCursor;
}
