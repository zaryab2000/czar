import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fixtureMerchantResponse } from "#src/social/fixture-merchants";

const ports = [8788, 8789];
for (const port of ports) {
  const server = createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
      else if (value !== undefined) headers.set(key, value);
    }
    const response = fixtureMerchantResponse(
      new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    Readable.fromWeb(response.body as never).pipe(outgoing);
  });
  server.listen(port, "127.0.0.1");
}
