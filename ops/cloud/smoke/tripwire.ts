// Smoke-run network tripwire (PM-014). Test code only: nothing under apps/ or packages/ imports it.
//
// The smoke run satisfies the cloud guard honestly: the RPC pointers stay https://rpc.testnet.arc.io,
// and the entries are handed chain clients that talk to a local arc-anvil instead. This tripwire
// makes sure that is the whole story: every `fetch` to a host that is not loopback is refused and
// reported on stderr, so a code path that would have reached Arc testnet, Circle, Google or any
// other real service fails the run instead of quietly contacting it.
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "::1"];

export const TRIPWIRE_MARK = "smoke-tripwire: refused";

export function installLoopbackTripwire(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK_HOSTS.includes(url.hostname)) {
      // The host only: a test-harness diagnostic, never a full URL with its query.
      process.stderr.write(`${TRIPWIRE_MARK} ${url.hostname}\n`);
      throw new TypeError(`smoke run: a request to ${url.hostname} was refused`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
