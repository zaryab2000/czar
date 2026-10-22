import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { FreezeIntent, FreezeIntentRequest } from "@czar/schemas";
import { encodeFreezeAction } from "@czar/vault-client";
import type { Context } from "hono";
import type { Pool } from "pg";
import { problem } from "#src/http/problem";
import { parseIdempotencyKey, RequestValidationError } from "#src/http/validate";

type ServerContext = Context<any, any, any>;

export async function createFreezeIntentRoute(
  context: ServerContext,
  pool: Pool,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId)
    return context.json(problem(401, "session-expired"), 401, {
      "Content-Type": "application/problem+json",
    });
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const body = await readRequest(context);
  const validator = apiContracts.get("createFreezeIntent")?.request;
  if (!validator || !validator(body)) throw new RequestValidationError();
  const account = await pool.query<{ vault: string | null; network: string }>(
    "SELECT vault,network FROM users WHERE user_id=$1",
    [userId],
  );
  const row = account.rows[0];
  if (!row?.vault)
    return context.json(problem(404, "validation"), 404, {
      "Content-Type": "application/problem+json",
    });
  const chainId = chainIdFromNetwork(row.network);
  const request = body as FreezeIntentRequest;
  const response: FreezeIntent = {
    vault: row.vault as `0x${string}`,
    to: row.vault as `0x${string}`,
    calldata: encodeFreezeAction(request.action),
    value: "0",
    chainId,
  };
  const exchange = validateRecordedExchange("createFreezeIntent", {
    requestBody: body,
    responseStatus: 200,
    responseBody: response,
  });
  if (!exchange.valid)
    throw new Error("Server response failed createFreezeIntent contract validation.");
  return context.json(response);
}

async function readRequest(context: ServerContext): Promise<unknown> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError();
  }
  try {
    return await context.req.json();
  } catch {
    throw new RequestValidationError();
  }
}

function chainIdFromNetwork(network: string): number {
  const [namespace, value] = network.split(":");
  const chainId = Number(value);
  if (namespace !== "eip155" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Cannot create freeze intent for an unsupported network.");
  }
  return chainId;
}
