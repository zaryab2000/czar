import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { setupDatabase } from "#test/db";
import { appSessionVerifier } from "#src/http/auth";

const getPool = setupDatabase();

describe("app session verifier foundation", () => {
  it("seededSession_authenticatesAndRefreshesItsExpiry", async () => {
    const pool = getPool();
    const token = Buffer.alloc(32, 11).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest();
    await pool.query("INSERT INTO users (user_id) VALUES ('usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y')");
    await pool.query(
      `INSERT INTO sessions (token_hash,user_id,expires_at)
       VALUES ($1,'usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y',now()+interval '1 hour')`,
      [tokenHash],
    );
    const before = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions WHERE token_hash=$1",
      [tokenHash],
    );
    const app = new Hono();
    app.use("/private", appSessionVerifier(pool, loadConfig()));
    app.get("/private", (context) => context.json({ ok: true }));
    const response = await app.request("/private", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const after = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions WHERE token_hash=$1",
      [tokenHash],
    );
    expect(response.status).toBe(200);
    expect(after.rows[0]?.expires_at.getTime()).toBeGreaterThan(
      before.rows[0]?.expires_at.getTime() ?? 0,
    );
  });

  it("unknownSession_isRejected", async () => {
    const app = new Hono();
    app.use("/private", appSessionVerifier(getPool(), loadConfig()));
    app.get("/private", (context) => context.json({ ok: true }));
    const response = await app.request("/private", {
      headers: { Authorization: `Bearer ${Buffer.alloc(32, 12).toString("base64url")}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  });
});
