import { createServer } from "node:http";

const server = createServer((incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/health") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end('{"status":"ok"}');
    return;
  }
  outgoing.writeHead(404, { "content-type": "application/json" });
  outgoing.end('{"error":"not found"}');
});

server.listen(Number(process.env["CZAR_MERCHANT_PORT"] ?? "8787"), "127.0.0.1");
const stop = () => server.close();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
