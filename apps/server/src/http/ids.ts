const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface RandomSource {
  bytes(length: number): Buffer;
}

/** Mint an opaque 130-bit public id with no timestamp component. */
export function randomId(prefix: string, random: RandomSource): string {
  const bytes = random.bytes(17);
  if (bytes.length !== 17) throw new RangeError("Random source must return 17 bytes.");
  let remaining = BigInt(`0x${bytes.toString("hex")}`) & ((1n << 130n) - 1n);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return `${prefix}${encoded}`;
}

export function ulid(prefix: string, now: Date, random: RandomSource): string {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 2 ** 48) {
    throw new RangeError("ULID timestamp must fit in 48 bits.");
  }
  const value = (BigInt(timestamp) << 80n) | BigInt(`0x${random.bytes(10).toString("hex")}`);
  let encoded = "";
  let remaining = value;
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return `${prefix}${encoded}`;
}

export function bearerToken(random: RandomSource): string {
  return random.bytes(32).toString("base64url");
}
