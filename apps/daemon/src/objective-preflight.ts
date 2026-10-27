import { KEYCHAIN_ACCOUNTS, type Keychain } from "#src/keychain";
import { parseObjectiveOptions, type ObjectiveOptions } from "#src/objective-options";

export interface ObjectivePreflight {
  readonly options: ObjectiveOptions;
  readonly token: string;
}

/** Requires pairing before parsing or sending any objective content. */
export function objectivePreflight(
  argv: readonly string[],
  keychain: Keychain,
  capabilityTaxonomy: unknown,
): ObjectivePreflight {
  let token: string | null;
  try {
    token = keychain.get(KEYCHAIN_ACCOUNTS.deviceToken);
  } catch {
    throw new Error(
      "Cannot access the paired device token; check keychain access and run czar pair.",
    );
  }
  if (!token) throw new Error("No paired device. Run czar pair <code> first.");
  const tags = readTags(capabilityTaxonomy);
  return { token, options: parseObjectiveOptions(argv, tags) };
}

function readTags(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("tags" in value) ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string")
  ) {
    throw new Error("drives.capabilityTaxonomy is invalid.");
  }
  return value.tags as string[];
}
