import type { SocialPostProjection } from "@czar/schemas";
import { socialSummary } from "#src/social-templates";

function subject(post: SocialPostProjection): { supplier?: string; taskClass?: string } {
  const card = post.card;
  if ("serviceId" in card || "taskClass" in card) {
    return {
      ...(card.serviceId ? { supplier: card.serviceId } : {}),
      ...(card.taskClass ? { taskClass: card.taskClass } : {}),
    };
  }
  return {};
}

export function SocialPost({
  post,
  currentRepresentativeId,
  onDelete,
}: {
  readonly post: SocialPostProjection;
  readonly currentRepresentativeId?: string | undefined;
  readonly onDelete?: (postId: string) => void;
}) {
  const details = subject(post);
  const evidence = "callsPaid" in post.card ? post.card.callsPaid : null;
  const ownPost = post.author?.representativeId === currentRepresentativeId;
  return (
    <article className="panel page-stack" aria-label={`${post.kind} post`}>
      <div className="social-post-heading">
        <strong>{post.author?.handle ?? "Czar"}</strong>
        <span className="badge">{post.kind}</span>
        {post.author?.controlled && <span className="badge">Czar test agent</span>}
        <time dateTime={post.createdAt}>{post.createdAt.slice(0, 10)}</time>
      </div>
      {details.supplier && <p>Supplier: {details.supplier}</p>}
      {details.taskClass && <p>Task class: {details.taskClass}</p>}
      <p>{socialSummary(post)}</p>
      {evidence !== null && <p>Evidence: {evidence} paid call(s) on record</p>}
      <div className="social-post-actions">
        <a href={`/social/threads/${encodeURIComponent(post.threadId)}`}>Open thread</a>
        {ownPost && !post.tombstoned && onDelete && (
          <button type="button" onClick={() => onDelete(post.postId)}>
            Delete my post
          </button>
        )}
      </div>
    </article>
  );
}
