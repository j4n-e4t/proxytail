import { generateKeyPair as generateKeyPairCb, randomBytes, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import forge from "node-forge";

const generateKeyPair = promisify(generateKeyPairCb);

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

/** forge writes CRLF line endings. */
const lf = (pem: string) => pem.replace(/\r\n/g, "\n");

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

/** A positive random serial number, as hex. */
const serial = () => "01" + randomBytes(15).toString("hex");

async function rsaKey(bits: number) {
  // Native key generation; forge's pure-JS RSA would take seconds.
  const { privateKey } = await generateKeyPair("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  return { key, publicKey: forge.pki.setRsaPublicKey(key.n, key.e) };
}

function validity(cert: forge.pki.Certificate, days: number) {
  // Backdated a little so clients with a slightly slow clock accept it right away.
  cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
}

/** A new self-signed root CA for client certificates. */
export async function generateCa(name: string, days: number) {
  const { key, publicKey } = await rsaKey(4096);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  validity(cert, days);
  const subject = [
    { name: "commonName", value: name },
    { name: "organizationName", value: "proxytail" },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const pem = lf(forge.pki.certificateToPem(cert));
  return { certPem: pem, keyPem: lf(forge.pki.privateKeyToPem(key)), summary: summarize(new X509Certificate(pem)) };
}

/**
 * Issues a client certificate signed by the CA. The private key is only returned here, bundled with the certificate
 * as PKCS#12 (for browsers and OS keychains) and as PEM (for curl and friends); it's never stored.
 */
export async function issueClientCert(ca: { certPem: string; keyPem: string }, commonName: string, days: number, password: string) {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const { key, publicKey } = await rsaKey(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  validity(cert, days);
  // Never outlive the CA: the chain would stop verifying anyway.
  if (cert.validity.notAfter > caCert.validity.notAfter) cert.validity.notAfter = caCert.validity.notAfter;
  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", clientAuth: true },
    { name: "subjectKeyIdentifier" },
    { name: "authorityKeyIdentifier", keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  // 3DES rather than forge's AES default: macOS and iOS keychains reject AES-encrypted PKCS#12 files.
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert, caCert], password, {
    algorithm: "3des",
    friendlyName: commonName,
  });
  const certPem = lf(forge.pki.certificateToPem(cert));
  return {
    certPem,
    keyPem: lf(forge.pki.privateKeyToPem(key)),
    p12: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64"),
    summary: summarize(new X509Certificate(certPem)),
  };
}
