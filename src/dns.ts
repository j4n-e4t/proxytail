import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { settings, type DnsCheck } from "./db";

// Query public resolvers so the result reflects what the internet sees, not local/split DNS.
const resolver = new Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function lookup(name: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolver.resolve4(name).catch(() => [] as string[]),
    resolver.resolve6(name).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

export function publicAddress() {
  return settings.get("public_address") || process.env.PUBLIC_ADDRESS || "";
}

/** The DNS record users should create for a domain, derived from the proxy's public address. */
export function requiredRecord(domain: string, address = publicAddress()) {
  if (!address) return null;
  const type = isIP(address) === 6 ? "AAAA" : isIP(address) ? "A" : "CNAME";
  return { name: `*.${domain}`, type, value: address };
}

export async function detectPublicIp(): Promise<string> {
  const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`IP detection failed (${res.status})`);
  return (await res.text()).trim();
}

export async function checkDomain(domain: string): Promise<DnsCheck> {
  const checkedAt = new Date().toISOString();
  const probe = `proxytail-check-${crypto.randomUUID().slice(0, 8)}.${domain}`;
  const address = publicAddress();
  const base = { checkedAt, wildcard: { name: probe, found: [] as string[] }, apex: { ok: false, found: [] as string[] } };
  if (!address) return { ...base, ok: false, expected: [], error: "Set the proxy's public address in Settings first." };

  const [expected, found, apexFound] = await Promise.all([
    isIP(address) ? [address] : lookup(address),
    lookup(probe),
    lookup(domain),
  ]);
  const matches = (ips: string[]) => ips.some((ip) => expected.includes(ip));
  const check: DnsCheck = {
    ...base,
    ok: matches(found),
    expected,
    wildcard: { name: probe, found },
    apex: { ok: matches(apexFound), found: apexFound },
  };
  if (!expected.length) check.error = `${address} does not resolve.`;
  else if (!found.length) check.error = `No wildcard record found: *.${domain} does not resolve.`;
  else if (!check.ok)
    check.error = `*.${domain} resolves to ${found.join(", ")} instead of ${expected.join(", ")}. If the record is proxied (e.g. Cloudflare's orange cloud), switch it to DNS only.`;
  return check;
}
