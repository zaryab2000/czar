import { expect, test, type Page } from "@playwright/test";
import type { AppPlan } from "@czar/schemas";

const PLAN_ID = `pln_${"A".repeat(26)}`;
const SELECTED = `svc_${"b".repeat(32)}`;
const AVOIDED = `svc_${"a".repeat(32)}`;
const LESSON_ID = `les_${"A".repeat(26)}`;
const INCIDENT_LINE =
  "This supplier has an open incident: several owners recently reported bad outcomes with it. Czar still ranks it as the best available. Approve to use it anyway.";

function approvalPlan(incidentOpen: boolean): AppPlan {
  return {
    schemaVersion: "1.4",
    planId: PLAN_ID,
    objectiveId: `obj_${"A".repeat(26)}`,
    objectiveHash: `0x${"1".repeat(64)}`,
    planHash: `0x${"2".repeat(64)}`,
    network: "eip155:5042002",
    category: "research",
    cap: "1000000",
    slackBps: 0,
    maxStepAmount: "1000000",
    pocketCapBps: 0,
    expiresAt: "2099-01-01T00:00:00Z",
    steps: [
      {
        stepIndex: 0,
        stepId: "step-social-approval",
        kind: "x402-exact",
        capability: "web-search",
        serviceId: SELECTED,
        resource: { url: "https://selected.example/search", method: "GET" },
        payee: `0x${"1".repeat(40)}`,
        unitAmount: "1000000",
        expectedCalls: 1,
        stepCap: "1000000",
        routingReason: "vault-direct",
        acceptanceProfileId: "json",
        why: {
          fills: ["answer"],
          summary: "It checked a search service.",
          alternativesLost: [],
          lessons: [
            {
              lessonId: LESSON_ID,
              handle: "Rep-ABCD",
              proposition: "avoid",
              serviceId: AVOIDED,
              taskClass: "data-json.search",
            },
          ],
        },
      },
    ],
    payeeLeaves: [
      {
        payee: `0x${"1".repeat(40)}`,
        kind: 1,
        stepIndex: 0,
        stepCap: "1000000",
      },
    ],
    payeeRoot: `0x${"3".repeat(64)}`,
    shadow: false,
    createdAt: "2026-11-05T00:00:00Z",
    ...(incidentOpen ? { approvalReasons: ["incident-open" as const] } : {}),
  };
}

async function mockApproval(page: Page, plan: AppPlan): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem("czar.appSession", "fixture-session");
    sessionStorage.setItem("czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z");
  });
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        userId: `usr_${"A".repeat(26)}`,
        network: "eip155:5042002",
        vaultCreated: true,
        mode: "controlled",
        balances: { free: "1000000", committed: "0", pocketOutstanding: "0", mscaBalance: "0" },
        limits: [],
        frozen: false,
        paused: false,
      }),
    }),
  );
  await page.route("**/v1/approvals?**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/v1/approvals/${PLAN_ID}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "X-Czar-Large-Cap-Warn-Bps": "5000" },
      body: JSON.stringify(plan),
    }),
  );
}

test("approval attributes an avoid lesson to its own supplier, not the chosen supplier", async ({
  page,
}) => {
  await mockApproval(page, approvalPlan(false));
  await page.goto(`/approve/${PLAN_ID}`);
  await expect(page.getByRole("heading", { name: "Review this plan" })).toBeVisible();
  await expect(page.getByText(`Payee: selected.example`)).toBeVisible();
  await expect(page.getByText(new RegExp(`that ${AVOIDED} did not`))).toBeVisible();
  await expect(page.getByText(new RegExp(`that ${SELECTED} did not`))).toHaveCount(0);
  await expect(page.getByText(INCIDENT_LINE)).toHaveCount(0);
});

test("approval warns about the selected plan's open incident", async ({ page }) => {
  await mockApproval(page, approvalPlan(true));
  await page.goto(`/approve/${PLAN_ID}`);
  await expect(page.getByRole("heading", { name: "Review this plan" })).toBeVisible();
  await expect(page.getByText(INCIDENT_LINE, { exact: true })).toBeVisible();
  await expect(page.getByText(/other owners reported bad outcomes/i)).toHaveCount(0);
});
