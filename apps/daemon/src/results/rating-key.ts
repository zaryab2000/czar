import { once } from "node:events";
import { emitKeypressEvents } from "node:readline";
import type { Writable } from "node:stream";
import type { ReadStream } from "node:tty";

/** Read exactly one rating key without waiting for Enter, restoring the terminal afterward. */
export async function readRatingKey(
  input: ReadStream,
  output: Writable,
  line: string,
): Promise<string> {
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  output.write(`${line}\n`);
  try {
    emitKeypressEvents(input);
    if (!wasRaw) input.setRawMode(true);
    const pressed = once(input, "keypress");
    input.resume();
    const [character] = await pressed;
    return typeof character === "string" ? character : "";
  } finally {
    if (!wasRaw) input.setRawMode(false);
    if (wasPaused) input.pause();
    output.write("\n");
  }
}
