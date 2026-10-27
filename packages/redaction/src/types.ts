// Shapes of the compiled layer-1 rule set (T-008).

export interface CompiledAllowlist {
  readonly condition: "AND" | "OR";
  /** What the allowlist regexes test: the secret (default), the whole match, or the line. */
  readonly target: "secret" | "match" | "line";
  readonly regexes: readonly string[];
  /** Lowercased; tested against the lowercased secret. */
  readonly stopwords: readonly string[];
  readonly hasPathOrCommitCheck: boolean;
}

export interface CompiledRule {
  readonly id: string;
  readonly description: string;
  /** JavaScript RegExp source, translated from RE2; null for path-only rules. */
  readonly regex: string | null;
  readonly pathRule: boolean;
  readonly keywords: readonly string[];
  readonly entropy: number;
  readonly secretGroup: number;
  readonly allowlists: readonly CompiledAllowlist[];
}

export interface RuleHit {
  readonly rule: string;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly hits: readonly RuleHit[];
}
