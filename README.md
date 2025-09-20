router-worker-edge

Overview
- Cloudflare Worker that proxies HTTPS requests for a browser-in-browser UI.
- Endpoints:
  - GET|HEAD `/p?sid=<sid>&u=<base64url(absolute_https_url)>` — media/static passthrough with Range support.
  - POST `/fetch` — JSON control plane for HTML/API navigation.
  - POST `/dispatch` — batch dispatcher for multiple upstream requests in one call.
- Streams bodies, filters headers, and optionally persists cookies per sandbox session via a Durable Object.

Production readiness and stability
- Status: Suitable for production in a controlled environment (known connector origin and target allowlist). It is not a public open proxy.
- Core features implemented and validated:
  - Strict https-only targets and method allowlist (GET|HEAD|POST)
  - Hop-by-hop and sensitive request header stripping
  - Range passthrough for `/p` and byte-accurate streaming for media
  - CORS pinning to a configured connector origin; OPTIONS preflight supported; responses vary by Origin
  - Optional cookie persistence per `sid` via Durable Object (basic jar per origin)
  - Batch dispatch (`/dispatch`) with per-request result payloads and optional sequential mode to preserve cookie order
- Known limitations (by design, document before going to public internet):
  - Open target surface: any https host is allowed. For the public internet, add an allowlist and/or token-based auth to the Worker.
  - Cookie jar is simplified: stored per origin only; ignores Domain/Path/Expiry/SameSite/HttpOnly. Treat as best-effort session continuity, not a spec-compliant cookie engine.
  - Authorization headers are stripped by default and not forwarded. If you need them for specific targets, add a controlled allowlist.
  - No per-tenant rate limits or quotas at the Worker layer (Cloudflare has platform-level protections). Consider adding limits for untrusted usage.
  - No HTML rewriting built in; use a separate Worker or Cloudflare HTMLRewriter if you need it.

Quick start
- Install deps: `npm i`
- Dev server: `npx wrangler dev`
- Type-check: `npm run typecheck`
- Dry-run build: `npm run build`

Deploy
- Login once: `npm run login`
- Deploy: `npm run deploy` (or `npx wrangler deploy`)

Configuration (wrangler.toml)
- Required:
  - `name = "router-worker-edge"`
  - `main = "src/index.ts"`
  - `vars.CONNECTOR_ORIGIN` — set to the exact origin of your Connector UI (e.g., `https://<user>.github.io`). Use `*` only for development.
- Optional Durable Object (cookie jar per `sid`):
  - Uncomment in `wrangler.toml`:
    - `durable_objects.bindings = [{ name = "SESSION_DO", class_name = "SessionDO" }]`
  - Add migration:
    - `[[migrations]]\n tag = "v1"\n new_classes = ["SessionDO"]`
  - Redeploy.

API reference

1) GET/HEAD /p — media/static passthrough
- Query: `sid`, `u` where `u` is base64url(absolute https URL)
- Headers: `Range` forwarded as-is
- Response: streams bytes; exposes `Content-Type, Content-Length, Accept-Ranges, Content-Range, ETag, Last-Modified, X-Set-Cookie`

PowerShell example (Windows)
- Encode URL and GET via `/p`:
```
$url = 'https://example.com'
$u = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url)).Replace('+','-').Replace('/','_').TrimEnd('=')
curl.exe -i "https://<your-subdomain>.workers.dev/p?sid=test-sid&u=$u"
```
- Range request:
```
curl.exe -i -H "Range: bytes=0-99" "https://<your-subdomain>.workers.dev/p?sid=test-sid&u=$u"
```

2) POST /fetch — JSON control plane
- Body JSON:
```
{ "sid": "sandbox-uuid", "target": "https://host/path", "method": "GET|POST|HEAD", "headers": { ... }, "bodyB64": "..." }
```
- Notes:
  - `target` must be absolute `https://`.
  - Request headers are filtered; hop-by-hop and disallowed headers (e.g., Host, Cookie, Authorization, Content-Length) are stripped.
  - `bodyB64` is base64url of the raw request body when method is POST.

PowerShell example
```
$payload = @{ sid = 'test'; target = 'https://example.com'; method = 'GET'; headers = @{} } | ConvertTo-Json -Depth 5
curl.exe -i -X POST "https://<your-subdomain>.workers.dev/fetch" -H "Content-Type: application/json" -d $payload
```

3) POST /dispatch — batch dispatcher
- Body JSON:
```
{
  "sid": "sandbox-uuid",
  "pipeline": "sequential" | "parallel",
  "requests": [
    {
      "id": "req-1",
      "target": "https://httpbin.org/get",
      "method": "GET",
      "headers": {"Accept":"application/json"},
      "responseType": "arrayBuffer" | "text" | "json" | "none"
    }
  ]
}
```
- Limits: up to 16 requests per call.
- Behavior: When `pipeline = sequential`, requests run one-by-one to preserve cookie write/read order.
- Response: `{ sid, pipeline, count, results: [{ id, ok, status, statusText, headers, finalUrl, redirected, durationMs, body? }] }`

PowerShell example (parallel batch)
```
$reqs = @(
  @{ id = 'one'; target = 'https://httpbin.org/get'; method = 'GET'; headers = @{ Accept = 'application/json' }; responseType = 'json' },
  @{ id = 'two'; target = 'https://example.com'; method = 'GET'; headers = @{}; responseType = 'text' }
) | ConvertTo-Json -Depth 8
$payload = "{\"sid\":\"test\",\"pipeline\":\"parallel\",\"requests\":$reqs}"
curl.exe -i -X POST "https://<your-subdomain>.workers.dev/dispatch" -H "Content-Type: application/json" -d $payload
```

Cookies
- With the DO enabled, upstream `Set-Cookie` headers are merged into a simple per-origin jar keyed by `sid`. The worker never returns raw `Set-Cookie`; instead, it emits `X-Set-Cookie` (URL-encoded), which your Connector’s Service Worker should parse and mirror. Subsequent requests to the same origin include the jar as `Cookie`.

Security notes
- Pin CORS: Set `CONNECTOR_ORIGIN` to your Connector UI origin. Avoid `*` in production.
- Prevent open-proxy abuse: consider one or more of the following before exposing broadly:
  - Restrict target hosts via an allowlist.
  - Require a bearer token/header and validate it in the Worker.
  - Rate-limit by IP/sid and/or use Cloudflare WAF rules.
- Header policy: Authorization is stripped by default. If needed, add tight host-level exceptions in code.

Acceptance checks
- Images via `/p` return bytes with correct `Content-Type`.
- `Range` on `/p` yields `206` with proper `Content-Range`.
- `/fetch` relays HTML/JSON with status passthrough and streaming.
- `/dispatch` returns per-request results, supports sequential and parallel modes.
- With DO enabled: repeated requests show cookies persisted per `sid`.

Development status
- This repository tracks the Worker only. The Connector UI integrates via HTTP contract (`/p`, `/fetch`, `/dispatch`). See `doc/` for internals.


