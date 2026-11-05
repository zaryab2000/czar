import { describe, expect, it } from "vitest";
import { feedCursor, mergeFeedPosts } from "#src/social-feed";

const post = (postId: string) => ({ postId });

describe("social feed polling", () => {
  it("keeps loaded older posts after a poll and shows each post once", () => {
    const older = [post("p3"), post("p2")];
    const polled = [post("p5"), post("p4"), post("p3")];
    expect(mergeFeedPosts(polled, older).map((item) => item.postId)).toEqual([
      "p5",
      "p4",
      "p3",
      "p2",
    ]);
  });

  it("keeps the older-page cursor once older posts are loaded", () => {
    expect(feedCursor("first-page-cursor", undefined)).toBe("first-page-cursor");
    expect(feedCursor("first-page-cursor", "older-cursor")).toBe("older-cursor");
    expect(feedCursor("first-page-cursor", null)).toBeNull();
  });
});
