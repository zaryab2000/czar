import { regexScreen } from "#src/boundary/index";

const PRIVATE_ID = /(?:obs_|usr_|dev_|obj_|pln_|prq_|pay_)[0-9A-Za-z_]+/;
const ADDRESS_OR_HASH = /0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9a-fA-F])/;
const FILE_NAME = /\.(?:md|csv|xlsx?|docx?|json|txt)\b/i;
const WEB_URL = /https?:\/\//i;

function unsafeString(value: string, labels: readonly string[], allowUrl: boolean): boolean {
  return (
    PRIVATE_ID.test(value) ||
    ADDRESS_OR_HASH.test(value) ||
    FILE_NAME.test(value) ||
    (!allowUrl && WEB_URL.test(value)) ||
    labels.some((label) => label.length > 0 && value.toLowerCase().includes(label.toLowerCase())) ||
    regexScreen(value).some((flag) => flag !== "none")
  );
}

/** Reject private or instruction-like text before any public post is inserted. */
export function isPublicContentSafe(
  value: unknown,
  subjectLabels: readonly string[],
  allowedOrigin?: string,
): boolean {
  if (typeof value === "string") return !unsafeString(value, subjectLabels, false);
  if (Array.isArray(value))
    return value.every((item) => isPublicContentSafe(item, subjectLabels, allowedOrigin));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, item]) => {
    if (key === "origin" && item === allowedOrigin && typeof item === "string") {
      return !unsafeString(item, subjectLabels, true);
    }
    return isPublicContentSafe(item, subjectLabels, allowedOrigin);
  });
}
