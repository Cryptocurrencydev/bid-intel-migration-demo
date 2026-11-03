import { parse } from "yaml";

export type Probe = { kind: "rows" | "dml" | "value" | "call"; sql: string; allow: string[]; control?: boolean };
export type BubbleRule = {
  name: string;
  when: string;
  view_fields?: string[] | "all";
  find_in_searches?: boolean;
  view_attached_files?: boolean;
  auto_binding?: Record<string, string> | "all";
};
export type DataType = {
  table: string;
  view?: string;
  bubble_rules: BubbleRule[];
  restricted_fields?: Record<string, string>;
  postgres?: { policies?: string[]; column_grants?: string; view?: string; rpc?: string[]; integrity?: string };
  probes?: Record<string, Probe>;
};
export type Spec = {
  app: string;
  personas: Record<string, { kind: string; org?: string; role?: string; label: string }>;
  fixtures: Record<string, string>;
  groups: Record<string, string[]>;
  option_sets: Record<string, string[]>;
  entitlements: Record<string, string[] | string>;
  data_types: Record<string, DataType>;
};

export function loadSpec(text: string): Spec {
  return parse(text) as Spec;
}

export function expandAllow(spec: Spec, allow: string[]): string[] {
  const out: string[] = [];
  for (const a of allow) {
    if (spec.groups[a]) out.push(...expandAllow(spec, spec.groups[a]));
    else out.push(a);
  }
  return [...new Set(out)];
}
