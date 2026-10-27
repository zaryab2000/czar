import { readFile } from "node:fs/promises";

export const LOCAL_KEY_IDS = ["K3", "K5", "K6", "K7", "K8", "relayer", "K20"];

const METADATA_KEYS = ["network", "chainId", "backend", "createdAt"];
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MERCHANT_KEY_PATTERN = /^K10:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates the public T-105 local manifest and returns its key entries. */
export function parseLocalKeysManifest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("local signer key manifest must be a JSON object");
  }
  if (
    value.network !== "arc-local" ||
    value.chainId !== 5042002 ||
    value.backend !== "local-keystore" ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("local signer key manifest must target Arc local chain 5042002");
  }
  const expectedKeys = [...METADATA_KEYS, ...LOCAL_KEY_IDS];
  const extraKeys = Object.keys(value).filter(
    (key) => !expectedKeys.includes(key) && !MERCHANT_KEY_PATTERN.test(key),
  );
  if (extraKeys.length > 0 || expectedKeys.some((key) => !(key in value))) {
    throw new Error(
      "local signer key manifest must contain the seven T-105 entries and valid K10 entries",
    );
  }

  const seenAddresses = new Set();
  const keyIds = Object.keys(value).filter(
    (key) => LOCAL_KEY_IDS.includes(key) || MERCHANT_KEY_PATTERN.test(key),
  );
  for (const keyId of keyIds) {
    const entry = value[keyId];
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).toSorted().join(",") !== "address,ref" ||
      typeof entry.address !== "string" ||
      !ADDRESS_PATTERN.test(entry.address) ||
      /^0x0{40}$/i.test(entry.address) ||
      entry.ref !== keyId
    ) {
      throw new Error(`local signer key manifest has invalid ${keyId} address/ref`);
    }
    const normalizedAddress = entry.address.toLowerCase();
    if (seenAddresses.has(normalizedAddress)) {
      throw new Error(`local signer key manifest repeats the ${keyId} address`);
    }
    seenAddresses.add(normalizedAddress);
  }
  return value;
}

export function addMerchantKeysToLocalManifest(value, addresses) {
  const manifest = parseLocalKeysManifest(value);
  const updated = { ...manifest };
  for (const [service, address] of Object.entries(addresses)) {
    const keyRef = `K10:${service}`;
    if (!MERCHANT_KEY_PATTERN.test(keyRef) || keyRef in updated) {
      throw new Error(`local signer key manifest already has or rejects ${keyRef}`);
    }
    updated[keyRef] = { address, ref: keyRef };
  }
  return parseLocalKeysManifest(updated);
}

async function main(args) {
  const [path, keyId] = args;
  if (path === undefined || !LOCAL_KEY_IDS.includes(keyId)) {
    throw new Error("usage: parse-local-keys.mjs <manifest-path> <T-105-key-id>");
  }
  const manifest = parseLocalKeysManifest(JSON.parse(await readFile(path, "utf8")));
  process.stdout.write(manifest[keyId].address);
}

if (process.argv[2] === "--cli") {
  main(process.argv.slice(3)).catch((error) => {
    process.stderr.write(`local key manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
