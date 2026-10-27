import type { NextConfig } from "next";

const config: NextConfig = {
  // Served by the local server at http://localhost in Phase 1 (D78).
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    const serverUrl = process.env["CZAR_SERVER_URL"] ?? "http://127.0.0.1:4310";
    return [{ source: "/v1/:path*", destination: `${serverUrl}/v1/:path*` }];
  },
};

export default config;
