// Snapshot mode: everything the UI shows was exported from the local / CI database by signing in
// as each persona (scripts/export-snapshot.ts). Nothing here re-implements the access rules.
import meta from "@/snapshot/meta.json";
import owner from "@/snapshot/personas/owner.json";
import member from "@/snapshot/personas/member.json";
import other from "@/snapshot/personas/other.json";
import researcher from "@/snapshot/personas/researcher.json";
import lapsed from "@/snapshot/personas/lapsed.json";
import anon from "@/snapshot/personas/anon.json";
import contracts from "@/snapshot/contracts.json";
import manifest from "@/snapshot/matrix-manifest.json";
import validation from "@/snapshot/validation-report.json";

export type PersonaKey = "owner" | "member" | "other" | "researcher" | "lapsed" | "anon";
export const PERSONA_KEYS: PersonaKey[] = ["owner", "member", "other", "researcher", "lapsed", "anon"];
const DATA = { owner, member, other, researcher, lapsed, anon } as const;

export type PersonaData = (typeof DATA)["owner"];
export function persona(key: string | undefined): { key: PersonaKey; data: PersonaData } {
  const k = (PERSONA_KEYS as string[]).includes(key ?? "") ? (key as PersonaKey) : "owner";
  return { key: k, data: DATA[k] as unknown as PersonaData };
}
export const allPersonas = () => PERSONA_KEYS.map((k) => ({ key: k, data: DATA[k] as unknown as PersonaData }));
export const snapshotMeta = meta;
export const sharedContracts = contracts as {
  id: string; piid: string; agency: string; vendor_name: string; naics: string; amount: number; award_date: string; set_aside: string; description: string;
}[];
export const matrixManifest = manifest as any;
export const validationReport = validation as any;

export async function resolveAs(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const sp = await searchParams;
  return { sp, ...persona(typeof sp.as === "string" ? sp.as : undefined) };
}
