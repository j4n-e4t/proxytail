# proxytail

A small web UI for exposing services on your tailnet through a Traefik reverse proxy. It works like a self-hosted
Cloudflare Tunnel or NetBird reverse proxy: a public hostname goes to Traefik, and Traefik forwards the request over
Tailscale to a peer's `100.x` address.

```
browser ──► app.example.com ──► Traefik (on the tailnet) ──► 100.x.y.z:port (a tailnet peer)
                                   ▲
                                   │ polls /api/traefik/config every 5s (HTTP provider)
                                proxytail (this app)
```

- **proxytail** (Bun + SQLite + React, shadcn/ui on Tailwind v4) stores your domains and services and lists tailnet
  devices through the Tailscale API. It also serves Traefik's dynamic configuration.
- **Traefik** shares the network namespace of a `tailscale/tailscale` sidecar, so it can reach peers directly.

## Deploying

The image is published to `ghcr.io/j4n-e4t/proxytail` for `linux/amd64` and `linux/arm64`.

```sh
cp .env.example .env    # set TS_AUTHKEY and Tailscale API credentials
docker compose up -d    # proxytail + Tailscale sidecar + Traefik
```

- The UI listens on `127.0.0.1:3000`. It has no authentication yet, so keep it on localhost or a private interface
  (`UI_BIND`, `UI_PORT`).
- Traefik serves public traffic on port 80 (`HTTP_PORT`). Its API stays internal.
- `TS_AUTHKEY` is only needed on first start. The node identity is kept in the `tailscale-state` volume, and app data
  in `proxytail-data`.
- Pin a release with `PROXYTAIL_IMAGE=ghcr.io/j4n-e4t/proxytail:0.1.0`, or build locally with
  `docker compose up -d --build`.

Then, in the UI:

1. **Settings:** add a Tailscale OAuth client with the `devices:core:read` scope (or an API access token), and set the
   public address, meaning the IP your domains point at. **Detect** fills in this machine's public IP.
2. **Domains:** add a domain and create the wildcard record it shows, e.g. `*.example.com A 203.0.113.10`. The domain is
   verified against public DNS resolvers.
3. **Services:** pick a subdomain, a tailnet device, and a port. The route goes live within about 5 seconds.

Your tailnet's access policy must allow the proxytail node to reach the target devices.

## Development

```sh
bun install
bun run dev                                     # UI on http://localhost:3000 (hot reload)
docker compose -f docker-compose.dev.yml up -d  # Traefik + Tailscale sidecar, pointed at the app on the host
```

- `docker compose -f docker-compose.dev.yml --profile demo up -d` adds an ephemeral `proxytail-demo` peer running
  `traefik/whoami`, which is useful as a first target.
- To develop without a tailnet, set `TS_MOCK_DEVICES=/path/devices.json`. The file uses the Tailscale API's
  `{ "devices": [...] }` format.
- `bun run build` compiles the server and the bundled frontend into a single executable, `dist/proxytail`. On macOS,
  run `codesign --force --sign - dist/proxytail` before starting it locally.
- UI components are from shadcn/ui (`src/web/components/ui`), using the blue theme in `src/web/globals.css`. Add
  components with `bunx --bun shadcn@latest add <name>`, then check that they import `cn` from `@/lib/utils`: the CLI
  resolves it to an unrelated npm package called `cn` in this repo.

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

- typecheck, compile the binary, and smoke-test it;
- build the multi-arch image. The Dockerfile cross-compiles on the native runner, so no QEMU is needed. It pushes to
  GHCR on `main` (`:latest`, `:sha-…`) and on `v*` tags (`:1.2.3`, `:1.2`).

## Not implemented yet

Authentication for the UI and the config endpoint, TLS/ACME, and SSO/forward-auth.
