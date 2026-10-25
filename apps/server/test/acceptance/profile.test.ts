import { profileId } from "@czar/hashing";
import { describe, expect, it } from "vitest";
import { localTemplateProfile } from "#src/acceptance/profile";

describe("local-template-v1 acceptance profile", () => {
  it("matches the canonical object and has a stable content-addressed ID", () => {
    const profile = localTemplateProfile();

    expect(profile).toEqual({
      profile_id: "prof_6d9d474de460595077cfa7ceccd7c70a",
      task_class: "local",
      version: 1,
      name: "local-template-v1",
      checks: [
        {
          name: "structural",
          kind: "structural",
          dimension: "structural",
          spec: {
            header: "inputTemplate.expectedKeys",
            rows: "one-per-subject",
            minFilledCells: 1,
          },
        },
      ],
    });
    expect(profile.profile_id).toBe(profileId(profile));
  });
});
