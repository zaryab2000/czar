export { GITLEAKS_VERSION, RULES } from "./generated/gitleaks-rules.ts";
export { detectSecrets, redactSecrets, shannonEntropy, TEXT_RULE_IDS } from "./layer1.ts";
export type { Finding } from "./layer1.ts";
export { LAYER2_METHOD } from "./layer2.ts";
export type {
  AnalyzeAnonymizeParams,
  AnalyzeAnonymizeResult,
  EntityCount,
  Layer2Client,
  Layer2Options,
  Layer2Result,
} from "./layer2.ts";
export { formatMarker, isValidMarker, parseMarkers, truncatePreservingMarkers } from "./markers.ts";
export type { Marker, MarkerLayer } from "./markers.ts";
export type { CompiledAllowlist, CompiledRule, RedactionResult, RuleHit } from "./types.ts";
