// Shapes of registry entries and resolved values (T-004).

export type ParameterType =
  | "integer"
  | "number"
  | "string"
  | "boolean"
  | "string[]"
  | "enum"
  | "object";

export type ParameterValue =
  | number
  | string
  | boolean
  | readonly string[]
  | Readonly<Record<string, unknown>>;

export interface ParameterSpec {
  readonly key: string;
  readonly type: ParameterType;
  readonly values?: readonly string[];
  readonly default: ParameterValue | null;
  readonly unit: string;
  readonly reason: string;
  readonly source: string;
  /** Mirror of a contract constant (03 czar-vault.md §3); never overridable. */
  readonly readOnly?: boolean;
  /** The specs give no default; an environment file or variable must set it before use. */
  readonly noDefault?: boolean;
  readonly stage2?: boolean;
  readonly derivedKey?: boolean;
  readonly partial?: boolean;
  readonly notes?: string;
}

export type ValueSource = "default" | "env-file" | "env-var";

export interface ResolvedParameter {
  readonly key: string;
  readonly value: ParameterValue | null;
  readonly source: ValueSource;
  readonly unit: string;
}
