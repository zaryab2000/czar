import { createHash, timingSafeEqual } from "node:crypto";
import type { MemoryDatabase } from "#src/database";

const SETTING_KEY = "paired-device";
const DEVICE_ID = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

interface StoredDevice {
  readonly deviceId: string;
  readonly tokenHash: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Persists the returned pairing ID in encrypted settings, bound to the K15 token. */
export function savePairedDevice(db: MemoryDatabase, deviceId: string, token: string): void {
  if (!DEVICE_ID.test(deviceId) || token.length === 0) {
    throw new Error("Pairing returned invalid device metadata; the ID was not saved.");
  }
  const value: StoredDevice = { deviceId, tokenHash: tokenHash(token) };
  db.prepare(
    `INSERT INTO settings (key,value_json) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
  ).run(SETTING_KEY, JSON.stringify(value));
}

/** Reads the ID only when it belongs to the currently paired K15 token. */
export function pairedDeviceId(db: MemoryDatabase, token: string): string {
  const row = db.prepare("SELECT value_json FROM settings WHERE key=?").get(SETTING_KEY) as
    | { value_json: string }
    | undefined;
  if (row === undefined) throw new Error("Paired device ID is missing. Run czar pair again.");
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    throw new Error("Paired device ID is invalid. Run czar pair again.");
  }
  if (!isStoredDevice(value)) throw new Error("Paired device ID is invalid. Run czar pair again.");
  const expected = Buffer.from(value.tokenHash, "hex");
  const current = Buffer.from(tokenHash(token), "hex");
  if (!timingSafeEqual(expected, current)) {
    throw new Error("Paired device ID does not match the token. Run czar pair again.");
  }
  return value.deviceId;
}

function isStoredDevice(value: unknown): value is StoredDevice {
  return (
    typeof value === "object" &&
    value !== null &&
    "deviceId" in value &&
    typeof value.deviceId === "string" &&
    DEVICE_ID.test(value.deviceId) &&
    "tokenHash" in value &&
    typeof value.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.tokenHash)
  );
}
