// Turning a fetched page into `{title, text, links[]}` (CZ-20 §5.1, §5.7).
//
// Everything here treats the page as data. Script and style elements are dropped with their contents,
// every remaining tag is removed, and the result is plain text, truncated to `merchants.extractMaxChars`.
// Agent-directed text inside a page (for example a vendor's "Agent Instructions" block) is returned
// verbatim as part of that plain text and is never acted on: this module runs no page script, follows no
// link and makes no request of its own.
const MAX_TITLE_CHARS = 200;
/** `links ≤ 50` (CZ-20 §5.1). */
export const MAX_LINKS = 50;

const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe"] as const;
/** Elements whose contents are code: an unclosed one must never leak its tail into the text. */
const CODE_ELEMENTS = ["script", "style"] as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return match;
  });
}

const collapse = (text: string) =>
  text
    .replace(/[\t\f\r ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

/** Removes comments, and every dropped element together with its contents. */
function stripNonText(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const element of DROPPED_ELEMENTS)
    out = out.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, "gi"), " ");
  // An unclosed script or style takes the rest of the document with it rather than leaking code.
  for (const element of CODE_ELEMENTS)
    out = out.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  return out;
}

function readTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (match === null) return "";
  return collapse(decodeEntities(match[1] ?? "")).slice(0, MAX_TITLE_CHARS);
}

/** Absolute http(s) link targets, in document order, deduplicated, capped at `MAX_LINKS`. */
function readLinks(html: string, baseUrl: string): readonly string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const anchors = html.matchAll(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi);
  for (const anchor of anchors) {
    const raw = decodeEntities(anchor[2] ?? anchor[3] ?? anchor[4] ?? "").trim();
    // An in-page anchor is not another page.
    if (raw === "" || raw.startsWith("#")) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    // Only web links are returned: a `javascript:`, `data:` or `mailto:` target is dropped.
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
    const href = resolved.href;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push(href);
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

export interface PageRead {
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
  /** The text came from outside Czar and is data, never an instruction (CZ-20 §5.7). */
  readonly untrusted: true;
}

export function readPage(options: {
  readonly html: string;
  /** The final URL the page came from, after any redirect safeFetch re-checked. */
  readonly baseUrl: string;
  /** `merchants.extractMaxChars`. */
  readonly maxChars: number;
}): PageRead {
  const title = readTitle(options.html);
  // Links are read from the stripped document, so a URL inside a script string is never offered.
  const body = stripNonText(options.html);
  const links = readLinks(body, options.baseUrl);
  const text = collapse(
    decodeEntities(
      body
        .replace(/<\s*(br|p|div|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n")
        .replace(/<\/\s*(p|div|li|tr|h[1-6]|section|article)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, " "),
    ),
  ).slice(0, options.maxChars);
  return { title, text, links, untrusted: true };
}
