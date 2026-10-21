const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface RandomSource {
  bytes(length: number): Buffer;
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
