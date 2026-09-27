import { X509Certificate } from "node:crypto";

/** Public details of a certificate, as shown in the UI. */
export interface CertSummary {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  /** SHA-256 fingerprint, colon-separated hex. */
  fingerprint: string;
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Common name, or the full distinguished name when there is none. */
function displayName(dn: string) {
  const cn = dn.split("\n").find((l) => l.startsWith("CN="));
  return cn ? cn.slice(3) : dn.replace(/\n/g, ", ");
}

function summarize(c: X509Certificate): CertSummary {
  return {
    subject: displayName(c.subject),
    issuer: displayName(c.issuer),
    serial: c.serialNumber,
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: new Date(c.validTo).toISOString(),
    fingerprint: c.fingerprint256,
  };
}

export class PkiError extends Error {}

/**
 * Validates an uploaded CA bundle: one or more PEM certificates, each a CA. Returns the normalized PEM (certificates
 * only, anything around them dropped) and the first certificate's details.
 */
export function parseCaBundle(input: string): { pem: string; summary: CertSummary; count: number } {
  const blocks = input.match(PEM_RE);
  if (!blocks?.length) throw new PkiError("No PEM certificate found. Paste a -----BEGIN CERTIFICATE----- block.");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input))
    throw new PkiError("The input contains a private key. Only upload the CA certificate.");
  const certs = blocks.map((b, i) => {
    try {
      return new X509Certificate(b);
    } catch {
      throw new PkiError(`Certificate ${i + 1} is not a valid X.509 certificate`);
    }
  });
  for (const c of certs)
    if (!c.ca) throw new PkiError(`${displayName(c.subject)} is not a CA certificate (basicConstraints CA:FALSE)`);
  return { pem: blocks.join("\n") + "\n", summary: summarize(certs[0]!), count: certs.length };
}
