router-worker-edge

Overview
- Cloudflare Worker that proxies HTTPS requests for a browser-in-browser UI.
- Endpoints:
  - GET|HEAD `/p?sid=<sid>&u=<base64url(absolute_https_url)>` — media/static passthrough with Range support.
  - POST `/fetch` — JSON control plane for HTML/API navigation.
- Streams bodies, filters headers, and optionally persists cookies per sandbox session via a Durable Object.

Allowed Methods
- Incoming:
  - `/p`: GET, HEAD, OPTIONS (preflight)
  - `/fetch`: POST, OPTIONS (preflight)
- Upstream to target: GET, HEAD, POST (validated and forwarded)

Response Headers (exposed to the browser)
- `Content-Type, Content-Length, Accept-Ranges, Content-Range, ETag, Last-Modified, X-Set-Cookie`
- Raw `Set-Cookie` is never forwarded. If cookies are captured, they are consolidated into `X-Set-Cookie` (URL-encoded) for the connector’s Service Worker to mirror client-side.

Configuration
- `wrangler.toml`
  - `name = "router-worker-edge"`
  - `main = "src/index.ts"`
  - `vars.CONNECTOR_ORIGIN` — set to your Connector origin for pinned CORS (or `*` for open CORS without credentials).
- Optional Durable Object (cookie jar per `sid`):
  - Uncomment in `wrangler.toml`:
    - `durable_objects.bindings = [{ name = "SESSION_DO", class_name = "SessionDO" }]`
  - Add migration:
    - `[[migrations]]\n tag = "v1"\n new_classes = ["SessionDO"]`
  - Redeploy.

Local Development
- Install deps: `npm i`
- Dev server: `npx wrangler dev`
- Type-check: `npm run typecheck`

Deploy
- Login once: `npm run login`
- Deploy: `npm run deploy` (or `npx wrangler deploy`)

Visiting a Target URL via /p
1) Base64url-encode an absolute `https://` URL and pass as `u`.
2) Include any `Range` header you need; it is forwarded to upstream.

Examples
- Bash (macOS/Linux):
  - `U=$(printf '%s' 'https://example.com' | base64 | tr '+/' '-_' | tr -d '=')`
  - `curl -i "https://<your-subdomain>.workers.dev/p?sid=test-sid&u=$U"`
- PowerShell (Windows):
  - `$url = 'https://example.com'`
  - `$u = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url)).Replace('+','-').Replace('/','_').TrimEnd('=')`
  - `curl.exe -i "https://<your-subdomain>.workers.dev/p?sid=test-sid&u=$u"`

Range example
- `curl -i -H "Range: bytes=0-99" "https://<your-subdomain>.workers.dev/p?sid=test-sid&u=$U"`

Using /fetch (programmatic navigation/API)
- Request body (JSON):
  - `{ "sid": "sandbox-uuid", "target": "https://host/path", "method": "GET|POST|HEAD", "headers": { ... }, "bodyB64": "..." }`
- Notes:
  - `target` must be absolute `https://`.
  - `headers` are filtered; hop-by-hop and disallowed headers (e.g., `Host`, `Cookie`, `Authorization`, `Content-Length`) are stripped.
  - `bodyB64` is optional; when present, it should be base64url of the raw request body.

Examples
- Fetch HTML (GET):
  - `curl -i -X POST https://<your-subdomain>.workers.dev/fetch \`
    `-H "Content-Type: application/json" \`
    `-d "{\"sid\":\"test\",\"target\":\"https://example.com\",\"method\":\"GET\",\"headers\":{}}"`
- POST JSON to an API (body base64url):
  - Bash: `B=$(printf '%s' '{"hello":"world"}' | base64 | tr '+/' '-_' | tr -d '=')`
  - `curl -i -X POST https://<your-subdomain>.workers.dev/fetch \`
    `-H "Content-Type: application/json" \`
    `-d "{\"sid\":\"test\",\"target\":\"https://httpbin.org/post\",\"method\":\"POST\",\"headers\":{\"Content-Type\":\"application/json\"},\"bodyB64\":\"$B\"}"`

Cookies
- If the Durable Object is enabled, upstream `Set-Cookie` headers are merged into a per-`sid` cookie jar keyed by origin. The worker returns a consolidated `X-Set-Cookie` header (URL-encoded) that your Connector’s Service Worker can parse and mirror. On subsequent requests for the same `sid` and origin, the Worker attaches the jar as a `Cookie` header.

Security & Behavior
- Only absolute `https://` targets are allowed.
- Methods limited to `GET|HEAD|POST` upstream.
- CORS: `Access-Control-Allow-Origin` is set to `CONNECTOR_ORIGIN` (or `*`). Preflights supported.
- Bodies are streamed end-to-end. No raw `Set-Cookie` is exposed to the client.

