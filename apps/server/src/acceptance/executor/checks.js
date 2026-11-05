function check(name, result, detail) {
  return { name, result, ...(detail ? { detail } : {}) };
}

function deliveryCheck(input) {
  if (!input.paid) return check("delivery", "not_checked");
  if (!input.responseArrived) return check("delivery", "fail", { reason: "no-response" });
  if (
    input.statusCode === null ||
    (input.genericDelivery
      ? input.statusCode !== 200
      : input.statusCode < 200 || input.statusCode >= 300)
  )
    return check("delivery", "fail", { reason: "http-status" });
  if (input.bodyBytes === 0) return check("delivery", "fail", { reason: "empty-body" });
  if (input.elapsedMs > input.deliveryLimitMs)
    return check("delivery", "fail", { reason: "delivery-timeout" });
  if (input.bodyBytes > input.maxBodyBytes)
    return check("delivery", "fail", { reason: "body-too-large" });
  if (input.genericDelivery) {
    const mimeType = input.mimeType.toLowerCase().split(";", 1)[0].trim();
    const claimsJson = mimeType === "application/json" || mimeType.endsWith("+json");
    if (!claimsJson && !mimeType.startsWith("text/"))
      return check("delivery", "fail", { reason: "content-type" });
    if (claimsJson && !input.parsed.parseOk)
      return check("delivery", "fail", { reason: "invalid-json" });
  }
  return check("delivery", "pass", {
    statusCode: input.statusCode,
    durationMs: input.elapsedMs,
    bodyBytes: input.bodyBytes,
  });
}

function structuralCheck(input) {
  if (!input.responseArrived || input.bodyText === null) return check("structural", "not_checked");
  if (!input.parsed.parseOk) return check("structural", "fail", { parseOk: false });
  if (input.schemaState === "dropped")
    return check("structural", "inconclusive", { parseOk: true, schemaDropped: true });
  if (input.schemaState === "valid" && !input.schemaValid)
    return check("structural", "fail", { parseOk: true, schemaValid: false });
  if (input.schemaState === "valid" && input.schemaValid)
    return check("structural", "pass", { parseOk: true, schemaValid: true });
  if (input.shapeHash === null) return check("structural", "inconclusive", { parseOk: true });
  if (input.historyShapeHash === null)
    return check("structural", "inconclusive", { parseOk: true });
  return input.shapeHash === input.historyShapeHash
    ? check("structural", "pass", { parseOk: true, shapeMatch: true })
    : check("structural", "fail", { parseOk: true, shapeMatch: false });
}

function requirementCheck(input) {
  if (input.expectedKeys.length === 0) return check("requirement", "not_checked");
  if (!input.responseArrived || input.bodyText === null) return check("requirement", "not_checked");
  const value = input.parsed.value;
  const passed = input.expectedKeys.every(
    (key) =>
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, key) &&
      isNonEmpty(value[key]),
  );
  return check("requirement", passed ? "pass" : "fail", { keysPresent: passed });
}

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function markdownTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !lines[0].includes("|")) return false;
  const columns = lines[0].split("|").filter((cell) => cell.trim()).length;
  const separator = lines[1].replace(/^\||\|$/g, "").split("|");
  return (
    columns > 0 &&
    separator.length === columns &&
    separator.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
  );
}

function csv(text) {
  const rows = [[]];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      rows[rows.length - 1].push(cell);
      cell = "";
    } else if (character === "\n") {
      rows[rows.length - 1].push(cell.replace(/\r$/, ""));
      rows.push([]);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) return false;
  rows[rows.length - 1].push(cell.replace(/\r$/, ""));
  const meaningful = rows.filter((row) => row.some((field) => field.trim().length > 0));
  return meaningful.length > 0 && meaningful[0].every((field) => field.trim().length > 0);
}

function json(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function markdownList(text) {
  return text.split(/\r?\n/).some((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line));
}

function prose(text) {
  return text.trim().length > 0;
}

const formatChecks = {
  "markdown-table": markdownTable,
  csv,
  json,
  "markdown-list": markdownList,
  prose,
};

function runAcceptanceChecks(input) {
  const delivery = deliveryCheck(input);
  const structural = structuralCheck(input);
  const requirement = requirementCheck(input);
  const checks = [delivery, structural, requirement];
  if (
    input.deliveredAsIs &&
    input.outputFormat &&
    input.responseArrived &&
    input.bodyText !== null
  ) {
    const formatOk = formatChecks[input.outputFormat](input.bodyText);
    const index = checks.findIndex((item) => item.name === "structural");
    const previous = checks[index];
    checks[index] = formatOk
      ? check("structural", previous.result, {
          ...previous.detail,
          outputFormat: input.outputFormat,
        })
      : check("structural", "fail", {
          parseOk: input.parsed.parseOk,
          outputFormat: input.outputFormat,
        });
  }
  return checks;
}

globalThis.runAcceptanceChecks = runAcceptanceChecks;
