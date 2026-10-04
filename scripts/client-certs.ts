#!/usr/bin/env bun
/**
 * Generates a local CA and client certificates for testing proxytail's client-certificate verification (mTLS),
 * and gets the CA into a format proxytail accepts (a bare certificate PEM, no key — see src/pki.ts).
 *
 * Usage:
 *   bun scripts/client-certs.ts ca [common-name]              Create the CA once (idempotent)
 *   bun scripts/client-certs.ts issue <name> [days]           Issue a client cert signed by the CA (default 730 days)
 *   bun scripts/client-certs.ts show                          Print the CA certificate, ready to paste into proxytail
 *   bun scripts/client-certs.ts upload <base-url> [ca-name]   POST the CA certificate to a running proxytail
 *
 * Everything is written under client-certs/, which is gitignored. Requires OpenSSL 1.1.1+ (the `-addext` flag) —
 * on macOS that's Homebrew's openssl, not the system one.
 */
import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

const DIR = "client-certs";
const CA_DIR = `${DIR}/ca`;
const CA_KEY = `${CA_DIR}/ca.key`;
const CA_CRT = `${CA_DIR}/ca.crt`;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function sanitize(name: string | undefined, label: string): string {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) die(`${label} must be a simple name (letters, digits, ., _, -)`);
  return name!;
}

async function ensureCa(cn = "proxytail local CA") {
  if (await Bun.file(CA_CRT).exists()) {
    console.log(`CA already exists: ${CA_CRT}`);
    return;
  }
  await mkdir(CA_DIR, { recursive: true });
  console.log(`==> Creating CA (${cn})`);
  await $`openssl genrsa -out ${CA_KEY} 4096`.quiet();
  await $`chmod 600 ${CA_KEY}`.quiet();
  await $`openssl req -x509 -new -nodes -key ${CA_KEY} -sha256 -days 3650 -subj ${"/CN=" + cn} \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -out ${CA_CRT}`.quiet();
  console.log(`CA created: ${CA_CRT} (key: ${CA_KEY}, keep it private)`);
}

async function issue(rawName: string | undefined, days = "730") {
  const name = sanitize(rawName, "name");
  if (!(await Bun.file(CA_CRT).exists())) die("No CA yet. Run: bun scripts/client-certs.ts ca");

  const outDir = `${DIR}/${name}`;
  await mkdir(outDir, { recursive: true });
  const key = `${outDir}/${name}.key`;
  const csr = `${outDir}/${name}.csr`;
  const crt = `${outDir}/${name}.crt`;
  const p12 = `${outDir}/${name}.p12`;
  const extFile = `${outDir}/${name}.ext`;

  console.log(`==> Issuing client certificate for ${name}`);
  await $`openssl genrsa -out ${key} 2048`.quiet();
  await $`chmod 600 ${key}`.quiet();
  await $`openssl req -new -key ${key} -subj ${"/CN=" + name} -out ${csr}`.quiet();
  await Bun.write(extFile, "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\nbasicConstraints=CA:FALSE\n");
  await $`openssl x509 -req -in ${csr} -CA ${CA_CRT} -CAkey ${CA_KEY} -CAcreateserial \
    -out ${crt} -days ${days} -sha256 -extfile ${extFile}`.quiet();
  await rm(csr);
  await rm(extFile);

  const password = crypto.randomUUID().slice(0, 12);
  await $`openssl pkcs12 -export -inkey ${key} -in ${crt} -certfile ${CA_CRT} -out ${p12} -name ${name} -passout ${"pass:" + password}`.quiet();
  await $`chmod 600 ${p12}`.quiet();

  console.log(`
Client cert issued for ${name}:
  Key:         ${key}
  Certificate: ${crt}
  PKCS#12:     ${p12}  (import into a browser or the macOS Keychain; password: ${password})

Test with curl against a proxytail-fronted service:
  curl --cert ${crt} --key ${key} https://your-service.example/
`);
}

async function show() {
  if (!(await Bun.file(CA_CRT).exists())) die("No CA yet. Run: bun scripts/client-certs.ts ca");
  console.log(await Bun.file(CA_CRT).text());
}

async function upload(baseUrl: string | undefined, name = "Local dev CA") {
  if (!baseUrl) die("usage: bun scripts/client-certs.ts upload <base-url> [ca-name]");
  if (!(await Bun.file(CA_CRT).exists())) die("No CA yet. Run: bun scripts/client-certs.ts ca");
  const pem = await Bun.file(CA_CRT).text();
  const res = await fetch(new URL("/api/client-cas", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, pem }),
  });
  if (!res.ok) die(`upload failed (${res.status}): ${await res.text()}`);
  console.log("Uploaded:", await res.json());
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "ca":
    await ensureCa(args[0]);
    break;
  case "issue":
    await issue(args[0], args[1]);
    break;
  case "show":
    await show();
    break;
  case "upload":
    await upload(args[0], args[1]);
    break;
  default:
    die("usage: bun scripts/client-certs.ts <ca [common-name] | issue <name> [days] | show | upload <base-url> [ca-name]>");
}
