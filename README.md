# proxytail

A small web UI for exposing services on your tailnet through a Traefik reverse proxy. It works like a self-hosted
Cloudflare Tunnel or NetBird reverse proxy: a public hostname goes to Traefik, and Traefik forwards the request over
Tailscale to a peer's `100.x` address.

```
browser ──► app.example.com ──► Traefik ──► host's tailscale0 ──► 100.x.y.z:port (a tailnet peer)
                                   ▲
                                   │ polls /api/traefik/config every 5s (HTTP provider, Docker network)
                                proxytail (this app) ◄── tailscale serve ◄── you, over the tailnet
```

- **proxytail** (Bun + SQLite + React, shadcn/ui on Tailwind v4) stores your domains and services, lists tailnet peers
  through the Tailscale API, and serves Traefik's dynamic configuration.
- **Traefik** and proxytail run as containers on a private Docker network, on a dedicated proxy host that is itself on
  your tailnet. Traefik reaches peers through the host's Tailscale, and proxytail's UI is only published on the host's
  loopback, for `tailscale serve`.

It's built for personal and homelab use: there are no user accounts, and whoever can reach the UI has full access. See
[Security model](#security-model).

## Deploying

The image is published to `ghcr.io/j4n-e4t/proxytail` for `linux/amd64` and `linux/arm64`. The host needs Docker and
tailscaled running in kernel mode (the default outside containers), so containers can route to `100.x` addresses.

```sh
cp .env.example .env    # set TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET
docker compose up -d    # proxytail + Traefik
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

- The UI is published on the host's loopback (`127.0.0.1:3000`, `UI_PORT`) only. `tailscale serve` puts it on the
  tailnet at `https://<host>.<tailnet>.ts.net:8443` with a Let's Encrypt certificate; enable MagicDNS and HTTPS
  certificates for your tailnet first. It uses 8443 because Traefik's published 443 is bound on every host address,
  including the tailnet one. `--bg` keeps the configuration across reboots.
- Traefik serves public traffic on ports 80 and 443 (`HTTP_PORT` and `HTTPS_PORT`). Port 80 is required for Let's
  Encrypt's HTTP-01 challenge and redirects all other requests to HTTPS. Its API isn't published: proxytail reads
  router status from it over the Docker network.
- Every enabled service receives a Let's Encrypt certificate automatically. Keep port 80 reachable from the internet,
  point each hostname at the public address, and persist the `traefik-acme` volume so certificates survive restarts.
- Peers come from the Tailscale API through an OAuth client. Create one under **Settings → OAuth clients** in the admin
  console with only the `devices:core:read` scope: a leaked secret then exposes your device list and nothing else.
- Both containers run read-only and without capabilities, except for Traefik binding ports 80 and 443.
- Pin a release with `PROXYTAIL_IMAGE=ghcr.io/j4n-e4t/proxytail:0.1.0`, or build locally with
  `docker compose up -d --build`.

Then, in the UI:

1. **Settings:** set the public address, meaning the IP your domains point at. **Detect** fills in this machine's
   public IP.
2. **Domains:** add a domain and create the wildcard record it shows, e.g. `*.example.com A 203.0.113.10`. The domain is
   verified against public DNS resolvers.
3. **Services:** pick a subdomain, a tailnet peer, and a port. The route goes live within about 5 seconds.
4. Optionally, **Client CAs:** require client certificates for a service. See [Client certificates (mTLS)](#client-certificates-mtls).

Only peers tagged `tag:proxytail-backend` are listed and can be targeted. Change the tag under **Settings** or with
`TS_BACKEND_TAG`. Define the tag under `tagOwners` in your tailnet policy and apply it to each backend, e.g.
`tailscale up --advertise-tags=tag:proxytail-backend`. The policy must also allow the proxy host to reach those peers
(see [Security model](#security-model)).

## Client certificates (mTLS)

A service can require visitors to present a client certificate. Traefik checks it during the TLS handshake, before a
request reaches the service, so only devices holding a certificate get through.

1. **Client CAs:** generate a CA, or import the certificate of one you already use. proxytail keeps the key of a
   generated CA, so you can issue client certificates from it: each one is downloaded once as a password-protected
   `.p12` (for browsers, keychains and phones) and as PEM files (for `curl --cert … --key …`). Its private key isn't
   stored. An imported CA only needs its certificate; you issue certificates for it wherever its key lives.
2. **Services:** turn on **Client certificates**, pick the CAs to trust, and choose what happens without a
   certificate: reject the handshake, or let the visitor through and verify a certificate only if one is presented.
   **Forward certificate details** passes the subject, issuer, serial and validity to the service in the URL-encoded
   `X-Forwarded-Tls-Client-Cert-Info` header, and drops any value the client sent in it.

Each service gets its own Traefik TLS option (`tls.options.proxytail-host-<id>`) with the CA certificates inlined, so
nothing but the generated config is shared with Traefik. Traefik doesn't check revocation lists: a client certificate
stays valid until it expires. To cut off a lost device, switch its services to a new CA and reissue the other
certificates. A CA still used by a service can't be deleted.

## Security model

There are no accounts, passwords or sessions: **whoever can reach the UI has full access**, and access is controlled
at the network layer. That's a deliberate trade-off for personal and homelab setups on a dedicated proxy host.

- **Who can open the UI** is decided by your tailnet policy: it's only reachable through `tailscale serve` on the
  host. Grant the people who manage the proxy access to that port, and nobody else.
- **Browsers can't be abused against it.** A page a tailnet user visits could otherwise make their browser call the
  UI. proxytail rejects unknown `Host` headers, which blocks DNS rebinding, and rejects writes from other origins. It
  answers to IPs, single-label names, `*.ts.net` and `*.internal` names; add other hostnames to `UI_HOSTS`.
- **Traefik is internet-facing and can reach the UI** over the Docker network (it polls its config there). If Traefik
  is compromised, so is proxytail. On a dedicated proxy host that adds little: whoever controls Traefik can already
  reroute every service and reach everything the host can.
- **The tailnet policy limits what the host reaches**, and with it Traefik. Tag the proxy host and grant it only the
  backend ports you proxy:

```json
"tagOwners": {
  "tag:proxytail":         ["group:admins"],
  "tag:proxytail-backend": ["group:admins"]
},
"grants": [
  // The proxy host: only the backend ports it serves.
  { "src": ["tag:proxytail"], "dst": ["tag:proxytail-backend"], "ip": ["tcp:80", "tcp:443"] },
  // Who may open the UI.
  { "src": ["group:admins"], "dst": ["tag:proxytail"], "ip": ["tcp:8443"] }
]
```

- **Traefik's API is unauthenticated** (routers, services, basic auth hashes), so it's only reachable on the Docker
  network, like `/api/traefik/config`.

Traefik can reach the internet (it needs to for Let's Encrypt), and it holds the certificates and basic auth hashes it
serves. The keys of client CAs generated in the UI stay in proxytail's database (`proxytail-data`); Traefik only
receives their certificates.

## Development

```sh
bun install
bun run dev                                     # UI on http://localhost:3000 (hot reload)
docker compose -f docker-compose.dev.yml up -d  # Traefik, pointed at the app on the host
```

- The dev Traefik polls the app through `host.docker.internal` and reaches peers through your machine's Tailscale.
  Its API is published on `127.0.0.1:8080` only.
- The app listens on `127.0.0.1` by default, and has no login. Docker Desktop forwards `host.docker.internal` to it;
  with Docker on Linux, set `HOST` to the `docker0` address (not `0.0.0.0`, which would open it to your network).
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
