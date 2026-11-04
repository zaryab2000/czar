import type { Pool, PoolClient } from "pg";
import { randomId, type RandomSource } from "#src/http/ids";

export interface RepresentativeRow {
  representative_id: string;
  user_id: string;
  handle: string;
  sharing: "off" | "structured" | "discuss";
  sharing_version: number;
  paused: boolean;
  controlled: boolean;
  consent_text_version: string | null;
}

/** Create a representative on first pairing or lazily for a previously paired owner. */
export async function findOrCreateRepresentative(
  db: Pick<Pool, "query"> | PoolClient,
  userId: string,
  random: RandomSource,
): Promise<RepresentativeRow> {
  const id = randomId("rep_", random);
  const result = await db.query<RepresentativeRow>(
    `INSERT INTO social_representatives (representative_id,user_id,handle,controlled)
     SELECT $1,u.user_id,$2,u.controlled FROM users u WHERE u.user_id=$3
     ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id
     RETURNING representative_id,user_id,handle,sharing,sharing_version,paused,
       controlled,consent_text_version`,
    [id, `Rep-${id.slice(-4)}`, userId],
  );
  const representative = result.rows[0];
  if (!representative) throw new Error("Cannot create a representative for an unknown user.");
  return representative;
}

export async function updateRepresentative(
  db: PoolClient,
  userId: string,
  request: { sharing?: string; paused?: boolean; consentTextVersion?: string },
  now: Date,
): Promise<RepresentativeRow | null> {
  const version = request.consentTextVersion ?? null;
  const result = await db.query<RepresentativeRow>(
    `UPDATE social_representatives SET
       sharing=COALESCE($2,sharing), paused=COALESCE($3,paused),
       sharing_version=sharing_version + CASE WHEN $2 IS DISTINCT FROM sharing THEN 1 ELSE 0 END,
       consent_text_version=CASE WHEN $2 IS DISTINCT FROM sharing THEN $4
         ELSE consent_text_version END,
       consented_at=CASE WHEN $2 IS DISTINCT FROM sharing THEN $5 ELSE consented_at END,
       updated_at=$5
     WHERE user_id=$1
     RETURNING representative_id,user_id,handle,sharing,sharing_version,paused,
       controlled,consent_text_version`,
    [userId, request.sharing ?? null, request.paused ?? null, version, now],
  );
  return result.rows[0] ?? null;
}
