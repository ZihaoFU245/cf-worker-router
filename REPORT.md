Worker Integration Report

Summary
- Repo B now contains a Hono-based Worker that implements the agreed contract: GET|HEAD /p and POST /fetch, with header filtering, CORS, streaming, optional cookie persistence via Durable Object, and range passthrough for media.
- The deployed Worker URL: https://router-worker-edge.zihaofu12.workers.dev
- CORS is currently set to `*` via CONNECTOR_ORIGIN; pin this to the Connector origin for production.

Repository State (router-worker-edge)
- Entrypoint: `src/index.ts` (Hono app)
- Utilities: `src/utils.ts` (base64url, CORS, header filters)
- Optional cookies: `src/session_do.ts` (`SessionDO`)
- Config: `wrangler.toml` (`CONNECTOR_ORIGIN`, optional DO binding scaffold)
- README: usage, methods, examples

Newly Added
- Default Chrome-like User-Agent for upstream requests to avoid 405/412 responses from some origins that reject generic UAs.
- Behavior:
  - `/p`: forwards incoming UA if present; otherwise sets a default Chrome UA.
  - `/fetch`: if the incoming JSON `headers` includes a `User-Agent`, it is forwarded; otherwise a default Chrome UA is applied.

Endpoints & Behavior
- `/p` (GET|HEAD):
  - Query: `sid`, `u` where `u` is base64url(absolute https URL)
  - Forwards `Range` header as-is; streams body
  - Filters response headers to: `Content-Type, Content-Length, Accept-Ranges, Content-Range, ETag, Last-Modified`
  - Never forwards raw `Set-Cookie`; if upstream sets cookies, emits consolidated `X-Set-Cookie` (URL-encoded). If the DO is enabled, also merges into the per-`sid` jar keyed by origin.
- `/fetch` (POST):
  - JSON body: `{ sid, target, method: GET|HEAD|POST, headers, bodyB64? }`
  - Validates `https://` target, filters unsafe request headers, streams body
  - Same response header policy; optional `X-Set-Cookie`
- Preflight: OPTIONS for `/p` and `/fetch`

CORS
- `Access-Control-Allow-Origin` is set from `CONNECTOR_ORIGIN` (currently `*`).
- `Access-Control-Expose-Headers` includes: `Content-Type, Content-Length, Accept-Ranges, Content-Range, ETag, Last-Modified, X-Set-Cookie`.

Durable Object (Optional)
- Binding scaffold present but commented in `wrangler.toml`.
- To enable cookies across requests per `sid`:
  - Add DO binding and migration in `wrangler.toml` for `SessionDO`.
  - Redeploy with Wrangler.

Action Items
- Pin CORS: Set `CONNECTOR_ORIGIN` to your Connector’s exact origin before production.
- Optional: Enable `SessionDO` if you need cookie persistence between requests.
- Clean up: `worker.js` remains from an earlier prototype (POST /magic). It is unused (main is `src/index.ts`). Remove it to avoid confusion.

Verification Steps
- Visit a target via `/p`:
  - Base64url-encode `https://example.com` → `u`
  - `curl -i "https://router-worker-edge.zihaofu12.workers.dev/p?sid=test&u=$u"`
- Range:
  - `curl -i -H "Range: bytes=0-99" "https://router-worker-edge.zihaofu12.workers.dev/p?sid=test&u=$u"`
- `/fetch` GET:
  - `curl -i -X POST https://router-worker-edge.zihaofu12.workers.dev/fetch -H "Content-Type: application/json" -d '{"sid":"test","target":"https://example.com","method":"GET","headers":{}}'`

Status
- No functional changes required in Repo B at this time. Recommend pinning CORS, optionally enabling the DO, and removing the unused `worker.js` artifact.
