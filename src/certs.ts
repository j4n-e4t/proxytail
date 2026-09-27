import { connect } from "node:tls";

export type CertState = "valid" | "untrusted" | "pending" | "error";

export interface CertInfo {
  state: CertState;
  issuer?: string;
  subject?: string;
  validTo?: string;
  error?: string;
  checkedAt: string;
}

/** Where Traefik's websecure entrypoint is reachable from this process (defaults to the API host on :443). */
function tlsTarget() {
  if (process.env.TRAEFIK_TLS_ADDR) {
    const [host, port] = process.env.TRAEFIK_TLS_ADDR.split(":");
    return { host: host!, port: Number(port ?? 443) };
  }
  const api = new URL(process.env.TRAEFIK_API_URL ?? "http://localhost:8080");
  return { host: api.hostname, port: 443 };
}

/**
 * Connects to Traefik with the given SNI and inspects the certificate it serves. Traefik answers with its
 * self-signed "TRAEFIK DEFAULT CERT" until the ACME certificate for that hostname has been issued.
 *
 * Also works for services that require a client certificate, although the probe sends none: the server certificate
 * arrives before Traefik asks for the client's, and with TLS 1.3 Traefik only rejects the missing certificate after
 * the client considers the handshake complete, i.e. after `secureConnect` has fired and the result is settled.
 */
export function probeCertificate(servername: string): Promise<CertInfo> {
  const { host, port } = tlsTarget();
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername, rejectUnauthorized: false, timeout: 3000 });
    const done = (info: Omit<CertInfo, "checkedAt">) => {
      socket.destroy();
      resolve({ ...info, checkedAt });
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
      const subject = first(cert.subject?.CN);
      const issuer = [first(cert.issuer?.O), first(cert.issuer?.CN)].filter(Boolean).join(" · ") || undefined;
      const base = { issuer, subject, validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : undefined };
      if (!cert.subject || subject === "TRAEFIK DEFAULT CERT") return done({ ...base, state: "pending" });
      if (socket.authorized) return done({ ...base, state: "valid" });
      done({ ...base, state: "untrusted", error: String(socket.authorizationError ?? "not trusted") });
    });
    socket.once("timeout", () => done({ state: "error", error: `TLS connection to ${host}:${port} timed out` }));
    socket.once("error", (e) => done({ state: "error", error: e.message }));
  });
}

const cache = new Map<string, CertInfo>();

/** Cached probe: trusted certificates are re-checked hourly, everything else every 15s. */
export async function certificateFor(servername: string): Promise<CertInfo> {
  const hit = cache.get(servername);
  const ttl = hit?.state === "valid" ? 3_600_000 : 15_000;
  if (hit && Date.now() - new Date(hit.checkedAt).getTime() < ttl) return hit;
  const info = await probeCertificate(servername);
  cache.set(servername, info);
  return info;
}
