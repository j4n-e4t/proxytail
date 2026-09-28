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
- **CrowdSec** (optional) reads Traefik's access log, bans IPs that scan or attack your services, and answers
  Traefik's bouncer plugin. See [CrowdSec](#crowdsec).
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
docker login dhi.io     # Traefik is a Docker Hardened Image: log in with any Docker Hub account
docker compose up -d    # proxytail and Traefik (CrowdSec is opt-in, see below)
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
- The sidebar shows the versions of Tailscale, Traefik and, if it's on, CrowdSec. For Tailscale, that's the proxy host's client: the
  device whose endpoints include the public address set under **Settings**.
- Peers come from the Tailscale API through an OAuth client. Create one under **Settings → OAuth clients** in the admin
  console with only the `devices:core:read` scope: a leaked secret then exposes your device list and nothing else.
- proxytail and Traefik run on [Docker Hardened Images](https://hub.docker.com/hardened-images/catalog) (`dhi.io/static`
  and `dhi.io/traefik`): minimal, without a shell or package manager, as the unprivileged user 65532. See
  [Hardening](#hardening).
- Pin a release with `PROXYTAIL_IMAGE=ghcr.io/j4n-e4t/proxytail:0.1.0`, or build locally with
  `docker compose up -d --build`.

Then, in the UI:

1. **Settings:** set the public address, meaning the IP your domains point at. **Detect** fills in this machine's
   public IP.
2. **Domains:** add a domain and create the wildcard record it shows, e.g. `*.example.com A 203.0.113.10`. The domain is
   verified against public DNS resolvers.
3. **Services:** pick a subdomain, a tailnet peer, and a port. The route goes live within about 5 seconds.
4. Optionally, **Client CAs:** require client certificates for a service. See [Client certificates (mTLS)](#client-certificates-mtls).
5. Optionally, add CrowdSec and block the IPs it bans under **Settings → CrowdSec**. See [CrowdSec](#crowdsec).

Only peers tagged `tag:proxytail-backend` are listed and can be targeted. Change the tag under **Settings** or with
`TS_BACKEND_TAG`. Define the tag under `tagOwners` in your tailnet policy and apply it to each backend, e.g.
`tailscale up --advertise-tags=tag:proxytail-backend`. The policy must also allow the proxy host to reach those peers
(see [Security model](#security-model)).

## Client certificates (mTLS)

A service can require visitors to present a client certificate. Traefik checks it during the TLS handshake, before a
request reaches the service, so only devices holding a certificate get through.

1. **Client CAs:** upload the certificate of the CA that signs your client certificates (a bundle with intermediates
   is fine). proxytail only verifies client certificates: it never holds a CA key, so issue certificates with your own
   tooling, e.g. `step`, `easy-rsa` or `openssl`. Uploads that contain a private key are rejected.
2. **Services:** turn on **Client certificates**, pick the CAs to trust, and choose what happens without a
   certificate: reject the handshake, or let the visitor through and verify a certificate only if one is presented.
   **Forward certificate details** passes the subject, issuer, serial and validity to the service in the URL-encoded
   `X-Forwarded-Tls-Client-Cert-Info` header, and drops any value the client sent in it.

Each service gets its own Traefik TLS option (`tls.options.proxytail-host-<id>`) with the CA certificates inlined, so
nothing but the generated config is shared with Traefik. Traefik doesn't check revocation lists: a client certificate
stays valid until it expires. To cut off a lost device, switch its services to a new CA and reissue the other
certificates.

- A CA still used by a service can't be deleted, and a service can't be saved with a CA that no longer exists. The
  database enforces both, so concurrent edits can't leave a service without its CAs.
- Should a service that verifies client certificates ever end up without a CA anyway, proxytail fails closed: it
  doesn't route the service at all rather than serving it without the check, and the UI shows it as **Not routed**.
- A client can't get around the check by sending a different SNI name than the `Host` header, e.g. the name of a
  service without client certificates: Traefik answers `421 Misdirected Request` when their TLS options differ.

## Hardening

- **TLS:** Traefik refuses TLS handshakes for hostnames it has no certificate for (`sniStrict`), including clients that
  send no hostname at all. Scanners probing the IP get no certificate that reveals Traefik, and a service whose Let's
  Encrypt certificate is still being issued refuses connections until it arrives (the UI shows **Issuing**). Clients
  need TLS 1.2 or newer; set `TLS_MIN_VERSION=1.3` to require TLS 1.3. proxytail puts both into Traefik's default TLS
  option and into every service's own option (for client certificates), because a service's option replaces the
  default rather than extending it.
- **Unprivileged containers:** proxytail and Traefik run as user 65532 with a read-only filesystem, no capabilities
  and `no-new-privileges`. Traefik listens on 8000 and 8443 inside its container, and Docker publishes them on
  `HTTP_PORT` and `HTTPS_PORT`. A one-shot `volume-init` container hands Traefik's volumes to its user, including
  volumes a root Traefik created before.
- **Traefik's API** is only reachable on the Docker network, and its dashboard is off. Traefik doesn't check for new
  versions or send usage statistics, and Docker checks its health through `/ping`.
- **Resources:** every container has a memory limit (`APP_MEM_LIMIT`, `TRAEFIK_MEM_LIMIT`, `CROWDSEC_MEM_LIMIT`) and
  a process limit, and Docker rotates their logs at 10 MB (3 files).
- **Favicons:** proxytail fetches service icons from the backend itself. It follows redirects only on the backend (a
  `Location` naming another host is fetched from the backend too) and stops reading a response past its size limit.

## CrowdSec

[CrowdSec](https://www.crowdsec.net) is opt-in. It reads Traefik's access log, detects scanners, brute force
and known CVE probes (the `crowdsecurity/traefik` and `crowdsecurity/http-cve` collections), and bans the source IPs.
It also receives the community blocklist.

To add it, uncomment `COMPOSE_FILE=docker-compose.yml:docker-compose.crowdsec.yml` in `.env` and run
`docker compose up -d`. That adds CrowdSec and a log rotation container, turns on Traefik's access log and bouncer
plugin, and shows the **Security** page and **Settings → CrowdSec** in the UI. To go back to plain Traefik, comment it
out again and run `docker compose up -d --remove-orphans`: proxytail stops adding the bouncer, even if blocking was on,
and the CrowdSec volumes are kept for later.

Once it's added, detection always runs. Blocking is off until you turn on **Block banned IPs** under **Settings → CrowdSec**. Then every
service gets Traefik's [CrowdSec bouncer plugin](https://plugins.traefik.io/plugins/6335346ca4caa9ddeffda116/crowdsec-bouncer-traefik-plugin)
as its first middleware, before basic auth. Banned IPs get a `403`.

- **Live mode:** the bouncer asks CrowdSec's Local API about each client IP and caches a clean answer for 60 seconds
  (**Cache clean IPs for**). A new ban can take that long to apply to an IP that was just seen.
- **Fail closed:** while the Local API is unreachable, every request from an IP that isn't cached as clean is blocked.
  proxytail refuses to turn blocking on while CrowdSec is unreachable or rejects the key.
- **Never block:** IPs and CIDR ranges that skip the check, e.g. your home connection. CrowdSec's detection also ignores
  private addresses.
- **Secrets:** proxytail generates two on first start in the `crowdsec-secrets` volume, which CrowdSec and Traefik
  mount read-only:
  - the **bouncer key**. CrowdSec registers it as the bouncer `traefik`, and Traefik reads it from the file, so it
    never appears in Traefik's API. CrowdSec only registers a key it doesn't know yet. If the settings show **Key
    rejected**, e.g. after recreating one volume but not the other, run
    `docker compose exec crowdsec cscli bouncers delete traefik` and `docker compose restart crowdsec`.
  - an **auto-registration token**. proxytail uses it to register itself as a CrowdSec machine (`proxytail-<random>`)
    the first time it needs to. A machine can read alerts, which the Security page is built from, and lift bans. The
    token only works from private addresses.
- **Access log:** Traefik writes JSON to the `traefik-logs` volume, and the `logrotate` container truncates it past
  100 MB.
- **Client IPs** must reach Traefik unchanged. Docker's published ports keep IPv4 source addresses, but if the access
  log shows a Docker gateway address (`172.x`, `192.168.x`) instead, CrowdSec can't tell clients apart.
- **Traefik fetches the plugin** from plugins.traefik.io on every start (`CROWDSEC_BOUNCER_VERSION`). If that fails
  while blocking is on, Traefik doesn't route your services, and the settings show the error.
- Use `cscli` for anything else, e.g. `docker compose exec crowdsec cscli decisions list` or `cscli alerts list`.

The **Security** page shows what CrowdSec detected over the last 24 hours, 7 days or 30 days:

- alerts, attacking IPs and active bans, plus the size of the community blocklist;
- alerts over time, and the top scenarios, targeted services, countries and networks;
- active bans, which you can lift with **Unban**, and the latest alerts with the paths the attacker requested.

It only covers CrowdSec's own detections and `cscli` bans, not the community blocklist. Alerts are attributed to
services by hostname: the stack adds `target_fqdn` to CrowdSec's alert context. A lifted ban can take up to the
**Cache clean IPs for** duration to reach Traefik, because the bouncer caches bans for that long too.

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
- **CrowdSec's Local API and metrics** are only reachable on the Docker network too. The bouncer key only allows
  reading decisions. proxytail's machine account can also create and delete them; its password stays in proxytail's
  database. Anyone who can read the `crowdsec-secrets` volume can register a machine of their own. CrowdSec shares the IPs it bans with the CrowdSec network in exchange for the community
  blocklist.

Traefik can reach the internet (it needs to for Let's Encrypt), and it holds the certificates and basic auth hashes it
serves. Client CAs are stored as certificates only, without keys, so neither proxytail nor Traefik can mint client
certificates.

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
- `docker compose -f docker-compose.dev.yml --profile crowdsec up -d` adds CrowdSec; set `CROWDSEC_ENABLED=true` for
  the app. Its Local API and metrics are published on `127.0.0.1:8081` and `127.0.0.1:6060` for the app on the host
  (`CROWDSEC_LAPI_URL`, `CROWDSEC_METRICS_URL`). The app writes its CrowdSec secrets to `data/crowdsec/`, which Traefik
  and CrowdSec mount. Start the app before CrowdSec: CrowdSec restarts until the registration token exists. The dev
  Traefik always loads the bouncer plugin.
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
  GHCR on `main` (`:latest`, `:sha-…`) and on `v*` tags (`:1.2.3`, `:1.2`). The runtime base is pulled from
  `dhi.io`, so the repository needs the `DHI_USERNAME` and `DHI_TOKEN` secrets: a Docker Hub username and a personal
  access token with read access. Building locally needs `docker login dhi.io` too.

## Not implemented yet

SSO/forward-auth for proxied services.

## Credits

The Tailscale, Traefik and CrowdSec icons are from [selfh.st/icons](https://github.com/selfhst/icons) (CC BY 4.0).
