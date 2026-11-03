import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { MainNav, PersonaSwitcher } from "@/components/Chrome";
import { snapshotMeta } from "@/lib/snapshot";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "Bidmarker — Bubble → Supabase migration demo",
  description: "Bubble privacy rules translated to Postgres RLS, tested with a generated allow/deny matrix and an attacker suite; 20k-record Bubble migration with validation. Synthetic data.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f2f4a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="banner" role="note">
          <div className="wrap">
            <span>Snapshot mode: the live database runs locally / in CI, this is a snapshot.</span>
            <span className="muted" style={{ color: "#3d2a00" }}>Exported {snapshotMeta.generated_at.slice(0, 16).replace("T", " ")} UTC from {snapshotMeta.source} · synthetic data, fictional brand and agencies</span>
          </div>
        </div>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              ◆ Bidmarker <small>Bubble → Next.js + Supabase</small>
            </Link>
            <Suspense fallback={<nav className="main" />}>
              <MainNav />
            </Suspense>
          </div>
        </header>
        <Suspense fallback={<div className="switcher"><div className="wrap" /></div>}>
          <PersonaSwitcher />
        </Suspense>
        <main>
          <div className="wrap">{children}</div>
        </main>
        <footer className="site">
          <div className="wrap">
            <span>
              Demo by <a href="https://dctechltd.com">DC Tech</a>
            </span>
            <span>
              <a href="https://github.com/Cryptocurrencydev/bid-intel-migration-demo">Source on GitHub</a> · Bidmarker is fictional; all records are synthetic.
            </span>
          </div>
        </footer>
        {process.env.VERCEL ? <Analytics /> : null}
      </body>
    </html>
  );
}
