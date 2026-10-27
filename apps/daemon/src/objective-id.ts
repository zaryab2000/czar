import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mints a new schema-valid objective ULID from time and 80 random bits. */
export function newObjectiveId(now: Date, bytes: Buffer = randomBytes(10)): string {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 2 ** 48) {
    throw new RangeError("Objective timestamp must fit a ULID.");
  }
  if (bytes.length !== 10) throw new RangeError("Objective ID requires 10 random bytes.");
  let value = (BigInt(timestamp) << 80n) | BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `obj_${encoded}`;
}
