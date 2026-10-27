// JSON-lines logger with the fixed fields of cross-cutting §4 (T-005).
// Fields outside the allowlist are dropped and counted in `droppedFields`; nothing else is emitted.
import { acceptField, type FieldValue } from "./allowlist.ts";

export type Level = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  readonly service: string;
  /** Component id, `CZ-nn`. */
  readonly component: string;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

export interface Logger {
  log(level: Level, event: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  child(fields: Readonly<Record<string, unknown>>): Logger;
}

const EVENT = /^[a-z][a-z0-9_]{0,63}$/;
const COMPONENT = /^CZ-[0-9]{2}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,63}$/;

export function createLogger(
  options: LoggerOptions,
  bound: Readonly<Record<string, unknown>> = {},
): Logger {
  if (!SERVICE.test(options.service)) throw new Error("logger service must be a lowercase token");
  if (!COMPONENT.test(options.component)) throw new Error("logger component must be CZ-nn");
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: Level, event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    const line: Record<string, FieldValue> = {
      ts: now().toISOString(),
      level,
      service: options.service,
      component: options.component,
      event: EVENT.test(event) ? event : "invalid_event_name",
    };
    let dropped = 0;
    for (const [name, value] of Object.entries({ ...bound, ...fields })) {
      const accepted = acceptField(name, value);
      if (accepted === undefined || name in line) {
        dropped += 1;
      } else {
        line[name] = accepted;
      }
    }
    if (dropped > 0) line["droppedFields"] = dropped;
    sink(JSON.stringify(line));
  };

  return {
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
