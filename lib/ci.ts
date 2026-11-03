// Latest CI results: the release asset CI publishes on every green run of main, falling back to
// the copy committed under snapshot/ if GitHub is unreachable.
import fallback from "@/snapshot/ci-results.json";

export const REPO = "Cryptocurrencydev/bid-intel-migration-demo";
const ASSET = `https://github.com/${REPO}/releases/download/ci-latest/ci-results.json`;

export type CiBundle = typeof fallback & { source?: "release" | "snapshot" };

export async function latestCi(): Promise<CiBundle> {
  try {
    const res = await fetch(ASSET, { next: { revalidate: 300 }, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = (await res.json()) as CiBundle;
      if (j?.summary && Array.isArray(j.policies)) return { ...j, source: "release" };
    }
  } catch {
    /* fall through */
  }
  return { ...(fallback as CiBundle), source: "snapshot" };
}

import snapshotValidation from "@/snapshot/validation-report.json";
const VALIDATION_ASSET = `https://github.com/${REPO}/releases/download/ci-latest/validation-report.json`;

export async function latestValidation(): Promise<{ report: any; source: "release" | "snapshot" }> {
  try {
    const res = await fetch(VALIDATION_ASSET, { next: { revalidate: 300 }, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      if (j?.status && Array.isArray(j.counts)) return { report: j, source: "release" };
    }
  } catch {
    /* fall through */
  }
  return { report: snapshotValidation, source: "snapshot" };
}
