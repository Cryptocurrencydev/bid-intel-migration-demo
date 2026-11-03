"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const NAV = [
  ["/", "Overview"],
  ["/reports", "Reports"],
  ["/contracts", "Contracts"],
  ["/crm", "Capture CRM"],
  ["/security", "Security"],
  ["/migration", "Migration"],
] as const;

export const PERSONA_CHIPS = [
  ["owner", "Owner"],
  ["member", "Member"],
  ["other", "Other org"],
  ["researcher", "Researcher"],
  ["lapsed", "Lapsed payer"],
  ["anon", "Anonymous"],
] as const;

function useAs() {
  const sp = useSearchParams();
  const as = sp.get("as");
  return PERSONA_CHIPS.some(([k]) => k === as) ? (as as string) : "owner";
}

export function MainNav() {
  const path = usePathname();
  const as = useAs();
  return (
    <nav className="main" aria-label="Main">
      {NAV.map(([href, label]) => (
        <Link key={href} prefetch={false} href={`${href}?as=${as}`} aria-current={path === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function PersonaSwitcher() {
  const path = usePathname();
  const sp = useSearchParams();
  const as = useAs();
  return (
    <div className="switcher" role="navigation" aria-label="View the app as">
      <div className="wrap">
        <span className="label">View as</span>
        {PERSONA_CHIPS.map(([k, label]) => {
          const q = new URLSearchParams(sp.toString());
          q.set("as", k);
          return (
            <Link key={k} prefetch={false} className="chip" href={`${path}?${q.toString()}`} aria-current={as === k ? "true" : undefined} scroll={false}>
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
