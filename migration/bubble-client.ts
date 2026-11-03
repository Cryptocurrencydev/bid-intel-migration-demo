// Pages through Bubble's Data API: GET /api/1.1/obj/<type>?cursor=N&limit=100, retrying 429/5xx.
import type { BubbleRecord } from "./mock-bubble/generate";

export type BubbleClientOpts = { baseUrl: string; token: string; pageSize?: number; onPage?: (type: string, cursor: number, remaining: number) => void };

export async function fetchJson(url: string, token: string, attempt = 0): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`${url}: ${res.status} after ${attempt} retries`);
    const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 250 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
    return fetchJson(url, token, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function extractType(type: string, o: BubbleClientOpts, startCursor = 0): Promise<{ records: BubbleRecord[]; pages: number; retries: number }> {
  const records: BubbleRecord[] = [];
  let cursor = startCursor;
  let pages = 0;
  for (;;) {
    const body = await fetchJson(`${o.baseUrl}/obj/${type}?cursor=${cursor}&limit=${o.pageSize ?? 100}`, o.token);
    const { results, remaining, count } = body.response;
    records.push(...results);
    pages++;
    cursor += count;
    o.onPage?.(type, cursor, remaining);
    if (remaining === 0 || count === 0) break;
  }
  return { records, pages, retries: 0 };
}
