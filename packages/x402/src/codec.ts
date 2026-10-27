// Base64 JSON header codec with the 16 KiB decoded-size cap (02 §11.3).
export const MAX_HEADER_BYTES = 16 * 1024;

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>> | Headers;

export function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted)
      return Array.isArray(value) ? value[0] : (value as string | undefined);
  }
  return undefined;
}

export type Decoded =
  | { ok: true; value: unknown }
  | { ok: false; reason: "oversized" | "malformed" };

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function decodeBase64Json(text: string): Decoded {
  const trimmed = text.trim();
  // Base64 grows by 4/3; reject before decoding anything clearly over the cap.
  if (trimmed.length > Math.ceil((MAX_HEADER_BYTES * 4) / 3) + 4)
    return { ok: false, reason: "oversized" };
  if (!BASE64.test(trimmed)) return { ok: false, reason: "malformed" };
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length > MAX_HEADER_BYTES) return { ok: false, reason: "oversized" };
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export const encodeBase64Json = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");
