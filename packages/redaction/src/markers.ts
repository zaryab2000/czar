// Redaction markers, exactly 02 §3.1: `[[R:<layer>:<type>(#<n>)?]]`, ASCII only.
// `S` types are gitleaks rule ids (lowercase kebab-case); `P` types are Presidio entity names.

export type MarkerLayer = "S" | "P";

export interface Marker {
  readonly layer: MarkerLayer;
  readonly type: string;
  readonly n?: number;
  readonly start: number;
  readonly end: number;
}

const S_TYPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const P_TYPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const COUNTER = /^[1-9][0-9]{0,5}$/;
const CANDIDATE = /\[\[R:([SP]):([A-Za-z0-9_-]{1,64})(?:#([0-9]{1,6}))?\]\]/g;

export function formatMarker(layer: MarkerLayer, type: string, n?: number): string {
  const marker = `[[R:${layer}:${type}${n === undefined ? "" : `#${n}`}]]`;
  if (!isValidMarker(marker)) throw new Error(`invalid marker for ${layer}:${type}`);
  return marker;
}

export function isValidMarker(text: string): boolean {
  const found = parseMarkers(text);
  return found.length === 1 && found[0]?.start === 0 && found[0].end === text.length;
}

/** Every well-formed marker in `text`, in order. Malformed look-alikes are not markers. */
export function parseMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const layer = match[1] as MarkerLayer;
    const type = match[2] ?? "";
    const counter = match[3];
    if (!(layer === "S" ? S_TYPE : P_TYPE).test(type)) continue;
    if (counter !== undefined && !COUNTER.test(counter)) continue;
    markers.push({
      layer,
      type,
      ...(counter === undefined ? {} : { n: Number(counter) }),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return markers;
}

/**
 * Cuts `text` to at most `maxChars` without splitting a marker (CZ-02 §5.2: cut after redaction).
 * A marker that would be split is dropped whole.
 */
export function truncatePreservingMarkers(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  for (const marker of parseMarkers(text)) {
    if (marker.start < cut && marker.end > cut) {
      cut = marker.start;
      break;
    }
  }
  return text.slice(0, cut);
}
