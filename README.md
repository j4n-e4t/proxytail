# proxytail

A small web UI for exposing services on your tailnet through a Traefik reverse proxy. It works like a self-hosted
Cloudflare Tunnel or NetBird reverse proxy: a public hostname goes to Traefik, and Traefik forwards the request over
Tailscale to a peer's `100.x` address.

```
browser ──► app.example.com ──► Traefik (node proxytail-edge) ──► 100.x.y.z:port (a tailnet peer)
                                   ▲
                                   │ watches the config file proxytail writes (file provider, read-only volume)
                                proxytail (node proxytail, UI via tailscale serve)
```

- **proxytail** (Bun + SQLite + React, shadcn/ui on Tailwind v4) stores your domains and services and lists tailnet
  peers through its sidecar's tailscaled. It also writes Traefik's dynamic configuration.
- **Traefik** runs in a separate network namespace with its own `tailscale/tailscale` sidecar, i.e. its own tailnet
  node. It reaches peers directly, but can't reach proxytail: it never connects to it, and the UI only listens on
  proxytail's loopback. See [Security model](#security-model).

## Deploying

The image is published to `ghcr.io/j4n-e4t/proxytail` for `linux/amd64` and `linux/arm64`.

```sh
cp .env.example .env    # set TS_AUTHKEY
docker compose up -d    # proxytail + Traefik, each with a Tailscale sidecar
```

- The UI is served on the tailnet only, at `https://<TS_HOSTNAME>.<tailnet>.ts.net`, through `tailscale serve` in the
  sidecar with a Let's Encrypt certificate. Enable MagicDNS and HTTPS certificates for your tailnet first. proxytail
  itself only listens on loopback. See [Access control](#access-control) for who can open it.
- Traefik serves public traffic on ports 80 and 443 (`HTTP_PORT` and `HTTPS_PORT`), published by the
  `tailscale-edge` sidecar. Port 80 is required for Let's Encrypt's HTTP-01 challenge and redirects all other requests
  to HTTPS. Its API only listens on the internal `control` network, where proxytail reads router status from it.
- Traefik reads its routing table from the `traefik-dynamic` volume, which proxytail writes and Traefik mounts
  read-only. Changes go live within a second.
- Every enabled service receives a Let's Encrypt certificate automatically. Keep port 80 reachable from the internet,
  point each hostname at the public address, and persist the `traefik-acme` volume so certificates survive restarts.
- Two nodes join the tailnet: `proxytail` (the UI, `TS_AUTHKEY`) and `proxytail-edge` (Traefik, `TS_EDGE_AUTHKEY`,
  falling back to `TS_AUTHKEY`). The edge node advertises `tag:proxytail-edge`, so its key must be allowed to apply
  that tag: create `TS_EDGE_AUTHKEY` with that tag, or use an untagged key owned by one of the tag's `tagOwners`. Auth keys are only
  needed on first start. Node identities are kept in the `tailscale-state` and `tailscale-edge-state` volumes, and app
  data in `proxytail-data`.
- Both containers run read-only, without capabilities, and Traefik as an unprivileged user. A one-shot
  `traefik-init` container hands the `traefik-acme` volume to that user, which also migrates volumes from older
  versions.
- Pin a release with `PROXYTAIL_IMAGE=ghcr.io/j4n-e4t/proxytail:0.1.0`, or build locally with
  `docker compose up -d --build`.

Then, in the UI:

1. **Settings:** set the public address, meaning the IP your domains point at. **Detect** fills in this machine's
   public IP.
2. **Domains:** add a domain and create the wildcard record it shows, e.g. `*.example.com A 203.0.113.10`. The domain is
   verified against public DNS resolvers.
3. **Services:** pick a subdomain, a tailnet peer, and a port. The route goes live within about 5 seconds.

Only peers tagged `tag:proxytail-backend` are listed and can be targeted. Change the tag under **Settings** or with
`TS_BACKEND_TAG`. Define the tag under `tagOwners` in your tailnet policy and apply it to each backend, e.g.
`tailscale up --advertise-tags=tag:proxytail-backend`. The policy must allow both nodes to reach those peers: the edge
node to proxy to them, and the proxytail node to list them and fetch their favicons. See [Security model](#security-model)
for a policy.

Peers are read from the sidecar's tailscaled over its LocalAPI socket (`TS_SOCKET`, shared through the
`tailscale-socket` volume), so no API credentials are needed. It only sees peers the tailnet policy lets the proxytail
node reach.

## Access control

There are no passwords or sessions. proxytail identifies every request with tailscaled's whois, using the client's
Tailscale IP, and reads the caller's role from an app capability grant in your tailnet policy:

```json
"grants": [
  { "src": ["group:admins"], "dst": ["tag:proxytail"], "app": { "proxytail.dev/cap/ui": [{ "role": "admin" }] } },
  { "src": ["autogroup:member"], "dst": ["tag:proxytail"], "app": { "proxytail.dev/cap/ui": [{ "role": "viewer" }] } }
]
```

- `dst` is the proxytail node, here tagged with `TS_EXTRA_ARGS=--advertise-tags=tag:proxytail`. The same `src` also
  needs network access to the node's port 443.
- `admin` can change everything; `viewer` is read-only and can't see Traefik's generated config, which contains basic
  auth hashes. Tailnet users without a grant see an access denied page with the grant to add.
- Rename the capability with `TS_APP_CAPABILITY`.
- `tailscale serve` connects from loopback and sets `X-Forwarded-For` to the client's Tailscale IP, replacing any
  value the client sent. proxytail whois-es that IP, and only trusts the header on loopback connections. Only proxytail
  and its own sidecar share that loopback; Traefik is in another network namespace.
- `/api/traefik/config` shows the generated Traefik config to admins. Traefik itself doesn't use it.
- The UI only answers to its IPs and MagicDNS names, which blocks DNS rebinding. Add other hostnames to `UI_HOSTS`.
  Writes from another origin are rejected.

## Security model

Traefik is the only component exposed to the internet, so it's treated as the one most likely to be compromised:

- **It can't reach the UI.** Traefik runs in the `tailscale-edge` network namespace. proxytail only listens on the
  loopback of the other namespace, and Traefik only reads its config from a read-only volume, so there's no connection
  from Traefik to proxytail to abuse (e.g. by forging `X-Forwarded-For` to impersonate an admin).
- **Its API is internal.** Traefik's unauthenticated API (routers, services, basic auth hashes) listens only on the
  `control` network, which has no internet access and only the two sidecars attached. It isn't bound to the edge
  node's tailnet or public interfaces.
- **The tailnet policy limits what it reaches.** A compromised Traefik can reach whatever `tag:proxytail-edge` can,
  and that tag is where to enforce containment. Grant it only the backend ports you proxy, and grant nothing *to* it:

```json
"tagOwners": {
  "tag:proxytail":         ["group:admins"],
  "tag:proxytail-edge":    ["group:admins"],
  "tag:proxytail-backend": ["group:admins"]
},
"grants": [
  // The proxy: only the backend ports it serves.
  { "src": ["tag:proxytail-edge"], "dst": ["tag:proxytail-backend"], "ip": ["tcp:80", "tcp:443"] },
  // The UI node: peer listing and favicon fetches.
  { "src": ["tag:proxytail"],      "dst": ["tag:proxytail-backend"], "ip": ["tcp:80", "tcp:443"] },
  // Who may open the UI, and with which role.
  { "src": ["group:admins"], "dst": ["tag:proxytail"], "ip": ["tcp:443"],
    "app": { "proxytail.dev/cap/ui": [{ "role": "admin" }] } }
  // No grant has tag:proxytail-edge as its dst.
]
```

Traefik can still reach the internet (it needs to for Let's Encrypt), and it holds the certificates and basic auth
hashes it serves.

## Development

```sh
bun install
bun run dev                                     # UI on http://localhost:3000 (hot reload)
docker compose -f docker-compose.dev.yml up -d  # Traefik + Tailscale sidecar, pointed at the app on the host
```

- The dev Traefik polls `/api/traefik/config` over HTTP instead of using the file provider, because Docker Desktop's
  bind mounts don't deliver file change events. Its API is published on `127.0.0.1:8080` only.
- The app listens on `127.0.0.1` by default. Docker Desktop forwards `host.docker.internal` to it; with Docker on
  Linux, set `HOST` to the `docker0` address (not `0.0.0.0`: with `UI_AUTH=off` everyone who can connect is an admin).

- `bun run dev` sets `UI_AUTH=off`, since there's no tailscaled socket on the host to identify users with. Every
  request is an admin, so never set it in production. Peers come from `TS_MOCK_DEVICES`.
- `docker compose -f docker-compose.dev.yml --profile demo up -d` adds an ephemeral `proxytail-demo` peer running
  `demo/server.ts` on port 80, which is useful as a first target. Like `traefik/whoami`, it echoes each request, as a
  page with its own favicon.
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

SSO/forward-auth for proxied services.
