import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Pool } from "pg";
import type { Config } from "@czar/config";
import { problem } from "#src/http/problem";

export interface Principal {
  deviceId: string;
  userId: string;
}

export function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export async function authenticateDevice(
  context: Context,
  pool: Pool,
): Promise<{ principal?: Principal; code?: "validation" | "device-revoked"; digest: Buffer }> {
  const authorization = context.req.header("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  const tokenDigest = digest(match?.[1] ?? authorization);
  if (!match) return { code: "validation", digest: tokenDigest };
  const result = await pool.query<{
    device_id: string;
    user_id: string;
    token_hash: Buffer;
    revoked_at: Date | null;
  }>("SELECT device_id, user_id, token_hash, revoked_at FROM devices WHERE token_hash = $1", [
    tokenDigest,
  ]);
  const device = result.rows[0];
  if (!device || !timingSafeEqual(device.token_hash, tokenDigest)) {
    return { code: "validation", digest: tokenDigest };
  }
  if (device.revoked_at) return { code: "device-revoked", digest: tokenDigest };
  return { principal: { deviceId: device.device_id, userId: device.user_id }, digest: tokenDigest };
}

export function appSessionVerifier(pool: Pool, config: Config): MiddlewareHandler {
  return async (context, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(context.req.header("Authorization") ?? "");
    if (!match)
      return context.json(problem(401, "validation"), 401, {
        "Content-Type": "application/problem+json",
      });
    const token = match[1];
    if (!token)
      return context.json(problem(401, "validation"), 401, {
        "Content-Type": "application/problem+json",
      });
    const tokenHash = digest(token);
    const result = await pool.query<{ user_id: string }>(
      "UPDATE sessions SET last_used_at = now(), expires_at = now() + ($2 * interval '1 hour') WHERE token_hash = $1 AND expires_at > now() RETURNING user_id",
      [tokenHash, config.get("app.sessionHours")],
    );
    if (!result.rowCount)
      return context.json(problem(401, "validation"), 401, {
        "Content-Type": "application/problem+json",
      });
    context.set("appUserId", result.rows[0]?.user_id);
    return await next();
  };
}
