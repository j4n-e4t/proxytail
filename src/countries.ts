import { mkdirSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, settings } from "./db";

/**
 * The country of a client IP, from DB-IP's free "IP to Country Lite" database (CC BY 4.0, https://db-ip.com). proxytail
 * downloads it once into its data directory and looks addresses up in memory, so no visitor's address ever leaves the
 * host. DB-IP publishes a new edition every month, which proxytail fetches in the background.
 *
 * The file is a CSV of `first IP,last IP,country code` ranges, IPv4 and IPv6, covering every address; reserved ranges
 * (private networks, loopback, …) have the code ZZ. COUNTRY_DB_URL points at another file in the same format instead.
 */
const DIR = join(dataDir, "countries");
const FILE = join(DIR, "countries.csv.gz");
const CUSTOM_URL = process.env.COUNTRY_DB_URL?.trim() || null;
const dbipUrl = (edition: string) => `https://download.db-ip.com/free/dbip-country-lite-${edition}.csv.gz`;
/** How often proxytail checks whether a newer edition is due. */
const CHECK_MS = 12 * 3_600_000;
/** A file from COUNTRY_DB_URL has no edition, so it's fetched again after this long. */
const CUSTOM_MAX_AGE_MS = 30 * 86_400_000;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

mkdirSync(DIR, { recursive: true });

/** Index 0 is "no country": reserved ranges, and addresses the database doesn't cover. */
interface Tables {
  codes: string[];
  /** Sorted first addresses of IPv4 ranges; each range runs up to the next one's start. */
  v4: Uint32Array;
  v4Country: Uint8Array;
  /** Sorted first addresses of IPv6 ranges, as four 32-bit words each (most significant first). */
  v6: Uint32Array;
  v6Country: Uint8Array;
  ranges: number;
}

let tables: Tables | null = null;

interface Meta {
  /** Where the file came from. */
  url: string;
  /** DB-IP's edition, e.g. 2026-09; null for a file from COUNTRY_DB_URL. */
  edition: string | null;
  downloadedAt: string;
}

function loadMeta(): Meta | null {
  try {
    return JSON.parse(settings.get("country_db") ?? "") as Meta;
  } catch {
    return null;
  }
}

const state: {
  loading: boolean;
  downloading: boolean;
  /** The last failed load or download, until one succeeds. */
  error?: string;
  lastCheck?: string;
} = { loading: false, downloading: false };

// --- Addresses ---

function parseV4(s: string): number | null {
  // By hand rather than with a regex: the database has hundreds of thousands of them to parse.
  let n = 0;
  let octet = -1;
  let dots = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 46) {
      if (octet < 0 || ++dots > 3) return null;
      n = n * 256 + octet;
      octet = -1;
    } else if (ch >= 48 && ch <= 57) {
      octet = octet < 0 ? ch - 48 : octet * 10 + ch - 48;
      if (octet > 255) return null;
    } else return null;
  }
  return dots === 3 && octet >= 0 ? n * 256 + octet : null;
}

/** An IPv6 address as four 32-bit words, most significant first. */
function parseV6(s: string): number[] | null {
  const groups: number[] = [];
  // Where "::" stands for groups of zeros.
  let gap = -1;
  let i = 0;
  if (s.charCodeAt(0) === 58 && s.charCodeAt(1) === 58) {
    gap = 0;
    i = 2;
  }
  while (i < s.length) {
    let value = 0;
    let j = i;
    for (; j < s.length; j++) {
      const ch = s.charCodeAt(j) | 32;
      const digit = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 102 ? ch - 87 : -1;
      if (digit < 0) break;
      value = value * 16 + digit;
    }
    // An embedded IPv4 address, e.g. ::ffff:192.0.2.1, is the last two groups.
    if (s.charCodeAt(j) === 46) {
      const v4 = parseV4(s.slice(i));
      if (v4 === null) return null;
      groups.push(v4 >>> 16, v4 & 0xffff);
      break;
    }
    if (j === i || j - i > 4) return null;
    groups.push(value);
    if (j === s.length) break;
    if (s.charCodeAt(j) !== 58) return null;
    if (s.charCodeAt(j + 1) === 58) {
      if (gap >= 0) return null;
      gap = groups.length;
      i = j + 2;
    } else if (j + 1 === s.length) return null;
    else i = j + 1;
  }
  if (gap < 0 ? groups.length !== 8 : groups.length > 7) return null;
  if (gap >= 0) groups.splice(gap, 0, ...Array(8 - groups.length).fill(0));
  return [0, 2, 4, 6].map((k) => ((groups[k]! << 16) | groups[k + 1]!) >>> 0);
}

type Address = { v: 4; n: number } | { v: 6; w: number[] };

function parseIp(raw: string): Address | null {
  const s = raw.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  if (!s.includes(":")) {
    const n = parseV4(s);
    return n === null ? null : { v: 4, n };
  }
  const w = parseV6(s);
  if (!w) return null;
  // IPv4-mapped (::ffff:a.b.c.d): look it up as IPv4.
  if (w[0] === 0 && w[1] === 0 && w[2] === 0xffff) return { v: 4, n: w[3]! };
  return { v: 6, w };
}

const cmp6 = (a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number) => {
  for (let k = 0; k < 4; k++) {
    const d = a[ai + k]! - b[bi + k]!;
    if (d) return d;
  }
  return 0;
};

/** The last range starting at or before the address. */
function search(count: number, before: (i: number) => boolean) {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (before(mid)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The ISO 3166 code of the country an address is in, "" if it has none (reserved ranges, addresses the database
 * doesn't know, or text that isn't an address), or null while no database is loaded.
 */
export function countryOf(ip: string): string | null {
  const t = tables;
  if (!t) return null;
  const a = parseIp(ip);
  if (!a) return "";
  if (a.v === 4) {
    const i = search(t.v4.length, (i) => t.v4[i]! <= a.n);
    return i < 0 ? "" : t.codes[t.v4Country[i]!]!;
  }
  const i = search(t.v6Country.length, (i) => cmp6(t.v6, i * 4, a.w, 0) <= 0);
  return i < 0 ? "" : t.codes[t.v6Country[i]!]!;
}

export const countriesReady = () => tables !== null;

/** Two letters, as DB-IP uses them (ISO 3166-1 alpha-2, plus XK for Kosovo). ZZ marks reserved ranges. */
export const isCountryCode = (c: string) => /^[A-Z]{2}$/.test(c) && c !== "ZZ";

// --- Loading ---

/** A typed array that doubles as it fills. */
class Growable<T extends Uint32Array | Uint8Array> {
  length = 0;
  constructor(
    public data: T,
    private readonly make: (n: number) => T,
  ) {}
  push(...values: number[]) {
    if (this.length + values.length > this.data.length) {
      const next = this.make(Math.max(this.data.length * 2, this.length + values.length));
      next.set(this.data);
      this.data = next;
    }
    for (const v of values) this.data[this.length++] = v;
  }
  done() {
    return this.data.slice(0, this.length) as T;
  }
}

/** Builds the lookup tables from the CSV, streamed so the whole file never sits in memory at once. */
async function parse(path: string): Promise<Tables> {
  const file = Bun.file(path);
  const head = await file.slice(0, 2).bytes();
  let stream: ReadableStream<Uint8Array> = file.stream();
  if (head[0] === 0x1f && head[1] === 0x8b)
    stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);

  const codes = [""];
  const index = new Map<string, number>([["", 0]]);
  const codeIndex = (code: string) => {
    const c = code === "ZZ" ? "" : code;
    let i = index.get(c);
    if (i === undefined) {
      if (codes.length > 255) throw new Error("Too many country codes");
      index.set(c, (i = codes.length));
      codes.push(c);
    }
    return i;
  };

  const v4 = new Growable(new Uint32Array(1 << 16), (n) => new Uint32Array(n));
  const v4Country = new Growable(new Uint8Array(1 << 16), (n) => new Uint8Array(n));
  const v6 = new Growable(new Uint32Array(1 << 18), (n) => new Uint32Array(n));
  const v6Country = new Growable(new Uint8Array(1 << 16), (n) => new Uint8Array(n));
  // Where the previous range ended, plus one; null once a range reached the end of the address space.
  let next4: number | null = 0;
  let next6: number[] | null = [0, 0, 0, 0];
  let rows = 0;
  let invalid = 0;

  // Adjacent ranges of the same country are merged, and gaps between ranges have no country.
  const add4 = (first: number, last: number, c: number) => {
    if (next4 === null || first < next4) throw new Error("IPv4 ranges overlap or aren't sorted");
    if (first > next4) v4.push(next4), v4Country.push(0);
    if (!v4.length || v4Country.data[v4Country.length - 1] !== c) v4.push(first), v4Country.push(c);
    next4 = last === 0xffffffff ? null : last + 1;
  };
  const add6 = (first: number[], last: number[], c: number) => {
    if (next6 === null || cmp6(first, 0, next6, 0) < 0) throw new Error("IPv6 ranges overlap or aren't sorted");
    if (cmp6(first, 0, next6, 0) > 0) v6.push(...next6), v6Country.push(0);
    if (!v6Country.length || v6Country.data[v6Country.length - 1] !== c) v6.push(...first), v6Country.push(c);
    // last + 1, carrying through the words.
    const n = [...last];
    let k = 3;
    while (k >= 0 && n[k] === 0xffffffff) n[k--] = 0;
    if (k < 0) next6 = null;
    else {
      n[k]!++;
      next6 = n;
    }
  };

  const line = (text: string) => {
    if (!text.trim()) return;
    rows++;
    if (text.includes('"')) text = text.replaceAll('"', "");
    const c1 = text.indexOf(",");
    const c2 = text.indexOf(",", c1 + 1);
    if (c1 < 0 || c2 < 0) return void invalid++;
    const a = text.slice(0, c1).trim();
    const b = text.slice(c1 + 1, c2).trim();
    const code = text.slice(c2 + 1).trim().toUpperCase();
    if (code.length !== 2 || !/^[A-Z]{2}$/.test(code)) return void invalid++;
    if (a.includes(":")) {
      const first = parseV6(a);
      const last = parseV6(b);
      if (!first || !last || cmp6(first, 0, last, 0) > 0) return void invalid++;
      add6(first, last, codeIndex(code));
    } else {
      const first = parseV4(a);
      const last = parseV4(b);
      if (first === null || last === null || first > last) return void invalid++;
      add4(first, last, codeIndex(code));
    }
  };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    const text = rest + decoder.decode(value, { stream: !done });
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; start = nl + 1, nl = text.indexOf("\n", start)) line(text.slice(start, nl));
    rest = text.slice(start);
    if (done) break;
  }
  line(rest);

  // An HTML error page or the wrong kind of file has no valid rows at all.
  const valid = rows - invalid;
  if (!valid || invalid > rows / 100) throw new Error(`Not a country database: ${invalid} of ${rows} lines are invalid`);
  if (next4 !== null) v4.push(next4), v4Country.push(0);
  if (next6 !== null) v6.push(...next6), v6Country.push(0);
  return { codes, v4: v4.done(), v4Country: v4Country.done(), v6: v6.done(), v6Country: v6Country.done(), ranges: valid };
}

/** Loads the stored file, if there is one. */
async function loadStored() {
  if (!(await Bun.file(FILE).exists())) return;
  state.loading = true;
  try {
    tables = await parse(FILE);
    state.error = undefined;
    notifyLoaded();
  } catch (e) {
    state.error = `Couldn't read ${FILE}: ${(e as Error).message}`;
    console.error(state.error);
  } finally {
    state.loading = false;
  }
}

const listeners: (() => void)[] = [];

/** Calls `fn` whenever a database has been loaded, e.g. to fill in the countries of requests stored without one. */
export function onCountriesLoaded(fn: () => void) {
  listeners.push(fn);
  if (tables) fn();
}

function notifyLoaded() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

// --- Downloading ---

/** YYYY-MM of a date, in UTC like DB-IP's editions. */
const editionOf = (d: Date) => d.toISOString().slice(0, 7);

function previousEdition(edition: string) {
  const [y, m] = edition.split("-").map(Number) as [number, number];
  return editionOf(new Date(Date.UTC(y, m - 2, 1)));
}

class NotPublished extends Error {}

/** Downloads a file, checks that it parses, and only then replaces the current one. */
async function download(url: string, edition: string | null) {
  const tmp = `${FILE}.download`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
    if (res.status === 404 && edition) throw new NotPublished(`The ${edition} edition isn't published yet`);
    if (!res.ok || !res.body) throw new Error(`${url} returned ${res.status}`);
    // Streamed to disk, and cut off past the limit.
    const writer = Bun.file(tmp).writer();
    let size = 0;
    const reader = res.body.getReader();
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        if ((size += r.value.length) > MAX_DOWNLOAD_BYTES) throw new Error(`${url} is too large`);
        writer.write(r.value);
      }
    } finally {
      reader.releaseLock();
      await writer.end();
    }
    const parsed = await parse(tmp);
    await rename(tmp, FILE);
    tables = parsed;
    settings.set("country_db", JSON.stringify({ url, edition, downloadedAt: new Date().toISOString() } satisfies Meta));
    console.log(`Loaded the country database from ${url}: ${parsed.ranges.toLocaleString("en")} ranges`);
    notifyLoaded();
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Fetches the database if there's none yet, or a newer edition is due. `force` fetches it again regardless (the newest
 * DB-IP edition, or COUNTRY_DB_URL's file).
 */
async function update(force = false) {
  if (state.downloading) return;
  const meta = loadMeta();
  const now = new Date();
  state.lastCheck = now.toISOString();
  const current = editionOf(now);
  const stored = !!tables;
  const sameSource = CUSTOM_URL ? meta?.url === CUSTOM_URL : !!meta?.edition;
  if (!force && stored && sameSource) {
    if (CUSTOM_URL && now.getTime() - Date.parse(meta!.downloadedAt) < CUSTOM_MAX_AGE_MS) return;
    if (!CUSTOM_URL && meta!.edition! >= current) return;
  }
  state.downloading = true;
  try {
    if (CUSTOM_URL) await download(CUSTOM_URL, null);
    else {
      try {
        await download(dbipUrl(current), current);
      } catch (e) {
        // Early in the month, before DB-IP has published it: the previous edition is the newest one.
        if (!(e instanceof NotPublished)) throw e;
        const previous = previousEdition(current);
        if (!stored || !sameSource || meta!.edition! < previous) await download(dbipUrl(previous), previous);
      }
    }
    state.error = undefined;
  } catch (e) {
    const message = `Couldn't download the country database: ${(e as Error).message}`;
    if (state.error !== message) console.error(message);
    state.error = message;
  } finally {
    state.downloading = false;
  }
}

/** Downloads the newest database now, for the Update button. */
export async function updateCountries() {
  await update(true);
  return countryDbStatus();
}

export interface CountryDbStatus {
  state: "ready" | "loading" | "missing" | "error";
  downloading: boolean;
  error?: string;
  source: string;
  /** Whether the file comes from DB-IP, which asks for attribution. */
  dbip: boolean;
  edition: string | null;
  downloadedAt: string | null;
  lastCheck: string | null;
  path: string;
  ranges: number;
  /** Every country the database knows, for pickers. */
  countries: string[];
}

export async function countryDbStatus(): Promise<CountryDbStatus> {
  const meta = loadMeta();
  const size = await stat(FILE).then((s) => s.size, () => null);
  return {
    state: tables ? "ready" : state.loading || (state.downloading && size === null) ? "loading" : state.error ? "error" : "missing",
    downloading: state.downloading,
    error: state.error,
    source: CUSTOM_URL ?? "DB-IP IP to Country Lite",
    dbip: !CUSTOM_URL || /(^|\.)db-ip\.com$/.test(URL.parse(CUSTOM_URL)?.hostname ?? ""),
    edition: tables ? (meta?.edition ?? null) : null,
    downloadedAt: tables ? (meta?.downloadedAt ?? null) : null,
    lastCheck: state.lastCheck ?? null,
    path: FILE,
    ranges: tables?.ranges ?? 0,
    countries: (tables?.codes ?? []).filter(isCountryCode).sort(),
  };
}

// --- Traefik ---

export type CountryMode = "off" | "allow" | "block";

/** How Traefik reaches proxytail: over the Docker network in production, the host in development. */
const APP_URL = (
  process.env.TRAEFIK_APP_URL ||
  (process.env.NODE_ENV === "production" ? "http://app:3000" : `http://host.docker.internal:${process.env.PORT ?? 3000}`)
).replace(/\/+$/, "");

/**
 * A forwardAuth middleware that asks proxytail whether a request's client may reach the service. The countries are in
 * the URL, so the check always matches the configuration Traefik has. Traefik answers 500 while it can't reach
 * proxytail: services with country restrictions fail closed.
 */
export function countryMiddleware(mode: Exclude<CountryMode, "off">, countries: string[]) {
  return {
    forwardAuth: {
      address: `${APP_URL}/api/traefik/country?${mode}=${countries.join(",")}`,
      // Traefik sets X-Forwarded-For to the address the connection came from, ignoring what the client sent.
      trustForwardHeader: false,
      // Nothing else of the request is sent to proxytail: no cookies, no credentials.
      authRequestHeaders: ["X-Forwarded-For"],
    },
  };
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/**
 * The forwardAuth check: 200 lets the request through, anything else is Traefik's answer to the client. Addresses
 * without a country are never in an allowlist, and never blocked by a blocklist.
 */
export function checkCountry(req: Request): Response {
  if (!tables) return new Response("503 Service Unavailable: the country check isn't ready.\n", { status: 503, headers: TEXT });
  const params = new URL(req.url).searchParams;
  const allow = params.get("allow");
  const listed = (allow ?? params.get("block") ?? "").split(",");
  // The last address is the one Traefik added: the client's.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",").at(-1)!;
  const country = countryOf(ip);
  const inList = !!country && listed.includes(country);
  if (allow !== null ? inList : !inList) return new Response(null, { status: 200, headers: TEXT });
  return new Response("403 Forbidden: this service isn't available from your location.\n", { status: 403, headers: TEXT });
}

await loadStored();
void update();
setInterval(() => void update(), CHECK_MS).unref();
