// Mock of Bubble's Data API (GET /api/1.1/obj/<type>), the appforest_uf file CDN, and a Stripe
// customer export. Bearer auth, 100-record page cap, cursor/remaining paging and occasional 429s,
// like the real thing.
import { createServer, type Server } from "node:http";
import { generate, fileBytes } from "./generate";

export const MOCK_TOKEN = process.env.BUBBLE_API_TOKEN ?? "mock-bubble-admin-token";

export function startMockBubble(port = Number(process.env.BUBBLE_MOCK_PORT ?? 8787), opts: { throttleEvery?: number } = {}): Promise<Server> {
  const { data, stripeCustomers } = generate();
  // Bubble returns records in creation order unless sort_field is given.
  for (const list of Object.values(data)) list.sort((a, b) => a["Created Date"].localeCompare(b["Created Date"]) || a._id.localeCompare(b._id));
  const throttleEvery = opts.throttleEvery ?? 40;
  let hits = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith("/appforest_uf/")) {
      const { bytes, contentType } = fileBytes(url.pathname);
      res.writeHead(200, { "content-type": contentType, "content-length": String(bytes.length) });
      return res.end(bytes);
    }

    if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
      return send(401, { statusCode: 401, body: { status: "UNAUTHORIZED", message: "Invalid or missing API token" } });
    }

    if (url.pathname === "/stripe/customers.json") return send(200, { object: "list", data: stripeCustomers });

    if (url.pathname === "/api/1.1/meta") return send(200, { get: Object.keys(data) });

    const m = url.pathname.match(/^\/api\/1\.1\/obj\/([a-z_]+)$/);
    if (!m) return send(404, { statusCode: 404, body: { status: "NOT_FOUND", message: "Type not found" } });
    const list = data[m[1]];
    if (!list) return send(404, { statusCode: 404, body: { status: "NOT_FOUND", message: `Type ${m[1]} not found` } });

    hits++;
    if (throttleEvery > 0 && hits % throttleEvery === 0) {
      return send(429, { statusCode: 429, body: { status: "TOO_MANY_REQUESTS", message: "Rate limit" } }, { "retry-after": "1" });
    }

    const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    const results = list.slice(cursor, cursor + limit).map((rec) => JSON.parse(JSON.stringify(rec)));
    send(200, { response: { cursor, results, count: results.length, remaining: Math.max(0, list.length - cursor - results.length) } });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockBubble().then((s) => {
    const a = s.address();
    console.log(`mock Bubble Data API on http://127.0.0.1:${typeof a === "object" && a ? a.port : "?"}/api/1.1`);
  });
}
