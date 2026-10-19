// Root layout for the Czar approval app (CZ-22). Phase 1 targets desktop Safari and Chrome on macOS at
// http://localhost (D69, D78): no web manifest, no service worker, no Home Screen install.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Czar",
  description: "Approve, review and stop what your agents spend.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="czar-header">
          <span className="czar-wordmark">Czar</span>
        </header>
        <main className="czar-main">{children}</main>
      </body>
    </html>
  );
}
