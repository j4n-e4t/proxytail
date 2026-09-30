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
- **Valkey** optionally keeps the counters for per-client [rate limiting](#rate-limiting).
- **Requests:** proxytail reads Traefik's access log and shows every request your services get. See
  [Requests](#requests).
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
docker compose up -d    # proxytail, Traefik and Valkey
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
  Plain HTTP is redirected to HTTPS, and each service is served with a one-year HSTS header so browsers won't fall
  back to HTTP afterwards.
- **Settings** opens with the state of Tailscale, Traefik, rate limiting and the request log, including the versions
  of Tailscale, Traefik and Valkey. Each tile opens its section. For Tailscale, the version is the proxy host's
  client: the device whose endpoints include the public address set under **Settings → General**.
- Peers come from the Tailscale API through an OAuth client. Create one under **Settings → OAuth clients** in the admin
  console with only the `devices:core:read` scope: a leaked secret then exposes your device list and nothing else.
- All containers run as unprivileged users, read-only and without capabilities. See [Hardening](#hardening).
- Pin a release with `PROXYTAIL_IMAGE=ghcr.io/j4n-e4t/proxytail:0.1.0`, or build locally with
  `docker compose up -d --build`.

Then, in the UI:

1. **Settings → General:** set the public address, meaning the IP your domains point at. **Detect** fills in this machine's
   public IP.
2. **Domains:** add a domain and create the wildcard record it shows, e.g. `*.example.com A 203.0.113.10`. The domain is
   verified against public DNS resolvers.
3. **Services:** pick a subdomain, a tailnet peer, and a port, and optionally aliases (see [Aliases](#aliases)). The
   route goes live within about 5 seconds. The list
   shows each service's last 24 hours (requests per hour, 5xx rate, 95th percentile response time) and the days left
   on its certificate, turning orange below 21 days and red below 7: Traefik renews at 30.
4. Optionally, **Client CAs:** require client certificates for a service. See [Client certificates (mTLS)](#client-certificates-mtls).
5. Optionally, **Settings → Rate limiting:** limit how many requests each client IP can make. See
   [Rate limiting](#rate-limiting).
6. **Requests:** watch the traffic your services get, or pick **View requests** in a service's menu.

Only peers tagged `tag:proxytail-backend` are listed and can be targeted. Change the tag under **Settings → Tailscale** or with
`TS_BACKEND_TAG`. Define the tag under `tagOwners` in your tailnet policy and apply it to each backend, e.g.
`tailscale up --advertise-tags=tag:proxytail-backend`. The policy must also allow the proxy host to reach those peers
(see [Security model](#security-model)).

## Aliases

A service has one hostname, and any number of aliases under your verified domains, each in one of two modes:

- **Redirect** sends the visitor to the service's hostname, e.g. `www.example.com` to `example.com`. The port, path and
  query string are kept. The redirect is temporary (`302`, or `307` for methods other than GET, which keeps a `POST`
  a `POST`), so browsers don't hold on to it when you change the alias.
- **Parallel** serves the service under the alias too, and rewrites the `Host` header to the service's hostname, so
  the service only ever sees its own name. The path is untouched, and the name the client used is in
  `X-Forwarded-Host`.

Every alias gets its own Let's Encrypt certificate. Parallel aliases share the service's router, so authentication,
rate limiting and headers apply to them as well; redirect aliases have a router of their own, with the service's client
certificate requirement and HSTS. Requests to either count towards the service on the Requests page.

Services created with several hostnames keep the first one, and the others become parallel aliases. Unlike before,
the service now sees its own hostname for those, instead of the alias.

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

## Hiding from search engines

**Hide from search engines**, under **Advanced** in a service's editor, sends `X-Robots-Tag: noindex, nofollow` with
every response, including the `401` of basic auth and the `429` of rate limiting, so well-behaved crawlers don't list
the service. It doesn't keep anyone out.

## Hardening

- **TLS:** Traefik refuses TLS handshakes for hostnames it has no certificate for (`sniStrict`), including clients that
  send no hostname at all. Scanners probing the IP get no certificate that reveals Traefik, and a service whose Let's
  Encrypt certificate is still being issued refuses connections until it arrives (the UI shows **Issuing**). Clients
  need TLS 1.2 or newer; set `TLS_MIN_VERSION=1.3` to require TLS 1.3. proxytail puts both into Traefik's default TLS
  option and into every service's own option (for client certificates), because a service's option replaces the
  default rather than extending it.
- **Unprivileged containers:** proxytail and Traefik run as user 65532 (Valkey as its image's `valkey` user) with a read-only filesystem, no capabilities
  and `no-new-privileges`. Traefik listens on 8000 and 8443 inside its container, and Docker publishes them on
  `HTTP_PORT` and `HTTPS_PORT`. A one-shot `volume-init` container hands Traefik's volumes to its user, including
  volumes a root Traefik created before.
- **Traefik's API** is only reachable on the Docker network, and its dashboard is off. Traefik doesn't check for new
  versions or send usage statistics, and Docker checks its health through `/ping`.
- **Resources:** every container has a memory limit (`APP_MEM_LIMIT`, `TRAEFIK_MEM_LIMIT`) and
  a process limit, and Docker rotates their logs at 10 MB (3 files). Traefik's access log is a file that proxytail
  empties once it's read it past 16 MB.
- **Favicons:** proxytail fetches service icons from the backend itself. It follows redirects only on the backend (a
  `Location` naming another host is fetched from the backend too) and stops reading a response past its size limit.

## Migrating from main

The `crowdsec` branch isn't published to GHCR yet, so the migration builds the app on the proxy host.
`scripts/migrate-from-main.sh` moves a running `main` stack over. Your services, domains, client CAs,
settings and Let's Encrypt certificates stay in the same volumes: the database schema is unchanged, and nothing is
reissued.

```sh
cd /path/to/proxytail            # the checkout main's stack was started from, with its .env
git fetch origin && git checkout crowdsec
scripts/migrate-from-main.sh
```

It stops before touching the running stack if anything is missing, and then:

1. builds the app as `proxytail:crowdsec` and pulls Traefik and Valkey while `main` keeps serving;
2. stops the stack and backs up both volumes to `backups/proxytail-<time>.tar.gz`;
3. saves `.env` as `.env.pre-migration` and sets `PROXYTAIL_IMAGE=proxytail:crowdsec`, so a later
   `docker compose pull` can't swap `main`'s image back in (`docker compose pull` then fails for the app; update it
   with `git pull && docker compose build app && docker compose up -d`);
4. starts the new stack. `volume-init` hands the certificates to Traefik's unprivileged user;
5. waits for both containers to be healthy, and prints the state of Traefik's routers.

Services are down for the few seconds the containers are recreated. Afterwards, clients that send no hostname (SNI)
get no TLS connection (see [Hardening](#hardening)). Rate limiting stays off until you turn it on (see
[Rate limiting](#rate-limiting)).

To go back, run `scripts/migrate-from-main.sh rollback` **before** leaving the branch. It stops the stack, hands the
certificates back to root, which `main`'s Traefik runs as, and restores `.env`. Then run
`git checkout main && docker compose up -d --remove-orphans`. If the data itself needs restoring, the backup holds
`data/` and `letsencrypt/`, the contents of the `proxytail_proxytail-data` and `proxytail_traefik-acme` volumes.

## Rate limiting

Rate limiting is off until you turn on **Limit requests** under **Settings → Rate limiting**. Then every service gets
Traefik's [rateLimit](https://doc.traefik.io/traefik/middlewares/http/ratelimit/) middleware as its first middleware,
before basic auth, so it also slows down password guessing. Requests over the limit get `429 Too Many Requests` with a
`Retry-After` header.

- **Per client IP and service:** each service has its own middleware, so a client that hits the limit on one service
  can still use the others. Clients are told apart by their address as Traefik sees it. Docker's published ports keep
  IPv4 source addresses, but if the **Requests** page shows a Docker gateway address (`172.x`, `192.168.x`) as the
  client, every client shares one budget.
- **Average and burst:** a client can make **Burst** requests at once, e.g. when a page loads its scripts and images,
  and then keep up the **Average** per second, minute or hour. The defaults, 20 per second with a burst of 100, only
  stop floods.
- **Where requests are counted:**
  - **Traefik** keeps the counters in its own memory. Nothing else runs, but Traefik rebuilds its middlewares whenever
    the configuration changes, i.e. whenever you change a service, and on restart, and the counts start over.
  - **Valkey** keeps them in the `valkey` container, so they survive configuration changes and Traefik restarts. It
    only holds short-lived counters, so it writes nothing to disk and is capped at 32 MB. proxytail refuses
    to switch to Valkey while it can't reach it.
- **Fallback:** Traefik answers `500` to every request it can't count in Valkey. proxytail checks Valkey every
  5 seconds, and while it's down, it switches the middlewares to Traefik's memory until it's back. The settings show
  **Fallback** meanwhile.

## Requests

The **Requests** page shows what Traefik served over the last hour, 24 hours or 7 days:

- the number of requests and distinct clients, the share of 4xx and 5xx responses, and response times (95th
  percentile and median);
- requests over time, stacked by status class, and the top services, hostnames, clients and status codes. Click one to
  filter the page by it;
- the requests themselves, newest first: time, status, target (hostname and service), client IP and response time,
  with a search across hostnames and client IPs.

Each request is stored with those five things only. Paths, query strings, methods and headers aren't stored, and
Traefik doesn't write them to its access log in the first place.

**Live** refreshes the list every 5 seconds, and the figures every 5 seconds to a minute depending on the period. The
**No service** filter shows requests no service matched, e.g. for hostnames that aren't set up.

How it works:

- Traefik writes its access log as JSON to the `traefik-logs` volume, with every field dropped except the start time,
  client IP, hostname, router (the service), status and duration.
- proxytail follows the file, stores each request in its database, and empties the file once it has read it past
  16 MB, so it needs write access to the volume. If it can't, **Settings → Request log** says so.
- Requests are kept for 7 days by default (**Settings → Request log**, 1 to 90 days), and at most a million of them
  (`ACCESS_LOG_MAX_ROWS`). The figures for a period are computed in a background thread and reused for a few
  seconds, so a busy week doesn't slow down the UI.

## Security model

There are no accounts, passwords or sessions: **whoever can reach the UI has full access**, and access is controlled
at the network layer. That's a deliberate trade-off for personal and homelab setups on a dedicated proxy host.

- **Who can open the UI** is decided by your tailnet policy: it's only reachable through `tailscale serve` on the
  host. Grant the people who manage the proxy access to that port, and nobody else.
- **Browsers can't be abused against it.** A page a tailnet user visits could otherwise make their browser call the
  UI. proxytail rejects unknown `Host` headers, which blocks DNS rebinding, and rejects writes from other origins. It
  answers to IPs, single-label names, `*.ts.net` and `*.internal` names; add other hostnames to `UI_HOSTS`. The UI is
  also served with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so it can't be
  framed and clickjacked.
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
- **Valkey has no password** and is only reachable on the Docker network. It only holds rate limit counters.
- **The request log holds client IPs,** which are personal data, with the hostname, status and response time of each
  request. It stays in proxytail's database for the retention you set, and anyone who can open the UI can read it.

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
- The dev stack includes Valkey, published on `127.0.0.1:6379` for the app on the host (`VALKEY_ADDR`). Traefik
  reaches it as `valkey:6379` (`VALKEY_TRAEFIK_ADDR`).
- The dev Traefik writes its access log to `data/traefik-logs/`, which the app reads (`ACCESS_LOG_PATH` overrides
  the path). On Linux, the file belongs to Traefik's user, so the app can't empty it: remove it now and then.
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

## Credits

The Tailscale and Traefik icons are from [selfh.st/icons](https://github.com/selfhst/icons) (CC BY 4.0).
