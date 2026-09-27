// Demo backend for docker-compose.dev.yml: like traefik/whoami, it echoes the request it received, but as an HTML
// page with a favicon, to check what a proxied service looks like in the browser.
import { hostname, networkInterfaces } from "node:os";

const favicon = Bun.file(new URL("./favicon.svg", import.meta.url));
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

Bun.serve({
  port: Number(process.env.PORT ?? 80),
  routes: {
    "/favicon.svg": new Response(await favicon.bytes(), { headers: { "Content-Type": "image/svg+xml" } }),
    // Browsers ask for /favicon.ico when a page has no <link rel="icon">, e.g. on the health check or plain curl.
    "/favicon.ico": Response.redirect("/favicon.svg", 301),
  },
  fetch(req, server) {
    const ips = Object.values(networkInterfaces())
      .flat()
      .map((i) => i?.address)
      .filter(Boolean);
    const addr = server.requestIP(req);
    const lines = [
      `Hostname: ${hostname()}`,
      ...ips.map((ip) => `IP: ${ip}`),
      `RemoteAddr: ${addr ? `${addr.address}:${addr.port}` : "unknown"}`,
      `${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`,
      ...[...req.headers].map(([k, v]) => `${k}: ${v}`),
    ];
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>proxytail demo · ${escape(hostname())}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <pre>${escape(lines.join("\n"))}</pre>
  </body>
</html>
`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});

console.log(`demo backend listening on :${process.env.PORT ?? 80}`);
