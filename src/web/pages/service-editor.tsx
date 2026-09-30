import { useState, type FormEvent } from "react";
import { ArrowRight, Earth, Globe, KeyRound, Loader2, Plus, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CountryPicker } from "@/components/country-picker";
import { DeviceBadge } from "@/components/device-badge";
import { DevicePicker } from "@/components/device-picker";
import { ServiceIcon, serviceState } from "@/components/status";
import {
  api,
  type BasicAuthUser,
  type ClientAuth,
  type ClientCa,
  type CountryDbStatus,
  type CountryMode,
  type Device,
  type AliasMode,
  type Domain,
  type ProxyHost,
  type ProxyHostDraft,
  type TraefikStatus,
} from "@/lib/api";

interface EditorProps {
  devices: Device[];
  peerTag: string;
  domains: Domain[] | null;
  clientCas: ClientCa[] | null;
  basicAuthUsers: BasicAuthUser[] | null;
  traefik: TraefikStatus | null;
  countryDb: CountryDbStatus | null;
  onOpenDomains: () => void;
  onOpenClientCas: () => void;
  onOpenUsers: () => void;
  onOpenCountries: () => void;
  onCancel: () => void;
  onSaved: () => void;
}

/** Create (`hostId` null) or edit a service in a modal. `hosts` and `domains` are `null` while still loading. */
export function ServiceEditorDialog(
  props: EditorProps & { open: boolean; hosts: ProxyHost[] | null; hostId: number | null; initialDeviceId?: string },
) {
  const loading =
    props.domains === null ||
    props.clientCas === null ||
    props.basicAuthUsers === null ||
    (props.hostId !== null && props.hosts === null);
  const existing = props.hostId !== null ? props.hosts?.find((h) => h.id === props.hostId) : undefined;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent className="flex max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {loading ? (
          <div className="space-y-4 p-6">
            <DialogTitle className="sr-only">Loading service</DialogTitle>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : props.hostId !== null && !existing ? (
          <DialogHeader className="p-6">
            <DialogTitle>Service not found</DialogTitle>
            <DialogDescription>There is no service with id {props.hostId}.</DialogDescription>
          </DialogHeader>
        ) : (
          // Keyed so the form state resets when switching between services.
          <ServiceForm
            key={existing?.id ?? "new"}
            {...props}
            domains={props.domains!}
            clientCas={props.clientCas!}
            basicAuthUsers={props.basicAuthUsers!}
            existing={existing ?? null}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Tab = "domains" | "target" | "auth" | "advanced";

/** A titled block of the form, optionally switched on and off from its header. */
function Section(props: {
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          <p className="text-sm text-muted-foreground">{props.description}</p>
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

interface DomainRow {
  sub: string;
  base: string;
  /** Aliases only: every row after the first. */
  mode?: AliasMode;
}

const ALIAS_MODES: Record<AliasMode, string> = { redirect: "Redirect", parallel: "Parallel" };

/** Split a hostname into subdomain + base, preferring registered domains (longest match). */
function splitHostname(hostname: string, domains: Domain[]): DomainRow {
  const match = domains
    .filter((d) => hostname === d.name || hostname.endsWith(`.${d.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const base = match?.name ?? hostname.split(".").slice(1).join(".");
  return { sub: hostname === base ? "" : hostname.slice(0, -(base.length + 1)), base };
}

const joinHostname = ({ sub, base }: DomainRow) => (sub.trim() ? `${sub.trim().toLowerCase()}.${base}` : base);

function ServiceForm(
  props: EditorProps & {
    domains: Domain[];
    clientCas: ClientCa[];
    basicAuthUsers: BasicAuthUser[];
    existing: ProxyHost | null;
    initialDeviceId?: string;
  },
) {
  const { existing } = props;
  const verified = props.domains.filter((d) => d.verified);
  const defaultBase = verified[0]?.name ?? "";
  const [rows, setRows] = useState<DomainRow[]>(() =>
    existing
      ? [
          splitHostname(existing.domains[0]!, props.domains),
          ...existing.aliases.map((a) => ({ ...splitHostname(a.hostname, props.domains), mode: a.mode })),
        ]
      : [{ sub: "", base: defaultBase }],
  );
  const [deviceId, setDeviceId] = useState(existing?.deviceId ?? props.initialDeviceId ?? "");
  const [port, setPort] = useState(existing ? String(existing.targetPort) : "");
  const [scheme, setScheme] = useState<"http" | "https">(existing?.scheme ?? "http");
  const [skipVerify, setSkipVerify] = useState(existing?.insecureSkipVerify ?? false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [basicAuth, setBasicAuth] = useState(existing?.basicAuth ?? false);
  const [userIds, setUserIds] = useState<number[]>(existing?.basicAuthUserIds ?? []);
  const [clientAuth, setClientAuth] = useState<ClientAuth>(existing?.clientAuth ?? "off");
  // Preselect the only CA, the common case.
  const [caIds, setCaIds] = useState<number[]>(() =>
    existing?.clientCaIds.length
      ? existing.clientCaIds
      : props.clientCas.length === 1
        ? [props.clientCas[0]!.id]
        : [],
  );
  const [certHeaders, setCertHeaders] = useState(existing?.clientCertHeaders ?? false);
  const [noIndex, setNoIndex] = useState(existing?.noIndex ?? false);
  const [countryMode, setCountryMode] = useState<CountryMode>(existing?.countryMode ?? "off");
  const [countries, setCountries] = useState<string[]>(existing?.countries ?? []);
  const [tab, setTab] = useState<Tab>("domains");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const device = props.devices.find((d) => d.id === deviceId);
  const firstRow = rows.find((r) => r.base);
  const firstDomain = firstRow ? joinHostname(firstRow) : "app.example.com";
  // Bases shown in the dropdown: verified domains plus whatever existing hostnames already use.
  const baseOptions = [...new Set([...verified.map((d) => d.name), ...rows.map((r) => r.base).filter(Boolean)])];
  const pending = props.domains.filter((d) => !d.verified && !baseOptions.includes(d.name));

  const setRow = (i: number, patch: Partial<DomainRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleBasicAuth = (on: boolean) => {
    setBasicAuth(on);
    // Preselect the only user, the common case.
    if (on && !userIds.length && props.basicAuthUsers.length === 1) setUserIds([props.basicAuthUsers[0]!.id]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Point at the tab that needs fixing: its fields aren't visible from the others.
    const invalid = (t: Tab, message: string) => {
      setTab(t);
      setError(message);
    };
    if (rows.some((r) => !r.base)) return invalid("domains", "Pick a domain for the hostname and every alias.");
    if (!deviceId) return invalid("target", "Pick the tailnet peer that runs this service.");
    if (!port) return invalid("target", "Enter the port your service is listening on.");
    if (countryMode !== "off" && !countries.length)
      return invalid("auth", `Pick the countries to ${countryMode === "allow" ? "let in" : "keep out"}.`);
    if (basicAuth && !userIds.length) return invalid("auth", "Pick at least one user who can sign in.");
    if (clientAuth !== "off" && !caIds.length)
      return invalid("auth", "Pick a CA to verify client certificates against.");
    const draft: ProxyHostDraft = {
      domains: rows.map(joinHostname),
      aliases: rows.slice(1).map((r) => ({ hostname: joinHostname(r), mode: r.mode ?? "redirect" })),
      deviceId,
      targetPort: Number(port),
      scheme,
      insecureSkipVerify: scheme === "https" && skipVerify,
      enabled,
      basicAuth,
      basicAuthUserIds: basicAuth ? userIds : [],
      clientAuth,
      clientCaIds: clientAuth === "off" ? [] : caIds,
      clientCertHeaders: clientAuth !== "off" && certHeaders,
      noIndex,
      countryMode,
      countries: countryMode === "off" ? [] : countries,
    };
    setSaving(true);
    try {
      if (existing) await api.updateHost(existing.id, draft);
      else await api.createHost(draft);
      toast.success(existing ? "Service updated" : "Service created", {
        description: `${draft.domains[0]} → ${device?.name ?? existing?.deviceName}:${draft.targetPort}`,
      });
      props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** A subdomain field joined to a domain picker. A render function, not a component, so inputs keep their focus. */
  const hostnameInput = (row: DomainRow, index: number) => (
    <div className="flex min-w-0 flex-1">
      <Input
        autoFocus={index === 0 && !existing}
        value={row.sub}
        onChange={(e) => setRow(index, { sub: e.target.value.replace(/\s/g, "") })}
        placeholder={index === 0 ? "app" : "www"}
        aria-label={index === 0 ? "Subdomain" : "Alias subdomain"}
        className="min-w-0 flex-1 rounded-r-none font-mono focus-visible:z-10"
      />
      <Select value={row.base} onValueChange={(base) => setRow(index, { base })}>
        <SelectTrigger
          aria-label="Domain"
          className="max-w-[55%] min-w-40 rounded-l-none border-l-0 bg-muted/40 font-mono"
        >
          <span className="truncate">{row.base ? `.${row.base}` : "Select domain"}</span>
        </SelectTrigger>
        <SelectContent align="end">
          {baseOptions.map((b) => (
            <SelectItem key={b} value={b} className="font-mono">
              .{b}
              {!verified.some((d) => d.name === b) && (
                <span className="font-sans text-xs text-muted-foreground">not verified</span>
              )}
            </SelectItem>
          ))}
          {pending.map((d) => (
            <SelectItem key={d.name} value={d.name} disabled className="font-mono">
              .{d.name}
              <span className="font-sans text-xs text-muted-foreground">pending DNS</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const state = existing ? serviceState(existing, props.traefik) : null;
  const countryDbReady = props.countryDb?.state === "ready";
  // A service that already has restrictions keeps them editable while the database is (re)loading.
  const canRestrictCountries = countryDbReady || (existing?.countryMode ?? "off") !== "off";

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0">
        <DialogHeader className="border-b px-6 pt-6 pb-4 pr-12">
          <DialogTitle className="truncate">{existing ? existing.domains[0] : "New service"}</DialogTitle>
          <DialogDescription>
            {existing ? (
              <>
                Traefik router <code className="font-mono">proxytail-host-{existing.id}@http</code>
              </>
            ) : (
              "Expose a service on your tailnet through Traefik."
            )}
          </DialogDescription>
          <div className="mt-2 flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5">
            {existing && state ? (
              <ServiceIcon host={existing} state={state} />
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                <Globe className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-sm font-medium">{state?.label ?? "New service"}</p>
              <p className="text-xs whitespace-pre-line text-muted-foreground">
                {state?.detail ?? (enabled ? "Traefik routes it once it's created." : "Created without a route in Traefik.")}
              </p>
            </div>
            {/* Disabled services are removed from Traefik but kept here. */}
            <div className="flex shrink-0 items-center gap-2 pr-1">
              <Label htmlFor="service-enabled" className="text-sm font-normal text-muted-foreground">
                Enabled
              </Label>
              <Switch id="service-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
          <TabsList className="mt-3 w-full">
            <TabsTrigger value="domains">Hostnames</TabsTrigger>
            <TabsTrigger value="target">Target</TabsTrigger>
            <TabsTrigger value="auth">
              Access
              {(basicAuth || clientAuth !== "off" || countryMode !== "off") && (
                <span className="size-1.5 rounded-full bg-primary" aria-label="on" />
              )}
            </TabsTrigger>
            <TabsTrigger value="advanced">
              Advanced
              {noIndex && <span className="size-1.5 rounded-full bg-primary" aria-label="hidden from search engines" />}
            </TabsTrigger>
          </TabsList>
        </DialogHeader>

        {/* Fixed height so the dialog doesn't jump when switching tabs. */}
        <div className="h-[26rem] max-h-[60vh] overflow-y-auto px-6 py-5">
          <TabsContent value="domains" className="space-y-5">
            {baseOptions.length === 0 ? (
              <Section title="Hostname" description="Choose a subdomain on one of your verified domains.">
                <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
                  <p className="text-sm text-muted-foreground">
                    {pending.length
                      ? `${pending.map((d) => d.name).join(", ")} ${pending.length > 1 ? "are" : "is"} still waiting for DNS verification.`
                      : "You haven't added a domain yet."}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={props.onOpenDomains}>
                    <Globe /> Manage domains
                  </Button>
                </div>
              </Section>
            ) : (
              <>
                <Section
                  title="Hostname"
                  description="The service's address: a subdomain on one of your verified domains, or the domain itself with the subdomain left empty."
                >
                  {hostnameInput(rows[0]!, 0)}
                </Section>

                <Section
                  title="Aliases"
                  description={
                    <>
                      Other hostnames for this service. <strong>Redirect</strong> sends visitors to{" "}
                      <span className="font-mono">{firstDomain}</span>. <strong>Parallel</strong> serves the service
                      under the alias as well, and the service sees <span className="font-mono">{firstDomain}</span>.
                      The path is kept either way.
                    </>
                  }
                >
                  {rows.length > 1 && (
                    <div className="space-y-2">
                      {rows.slice(1).map((r, j) => {
                        const i = j + 1;
                        return (
                          <div key={i} className="flex gap-2">
                            {hostnameInput(r, i)}
                            <Select value={r.mode ?? "redirect"} onValueChange={(mode) => setRow(i, { mode: mode as AliasMode })}>
                              <SelectTrigger className="w-32 shrink-0" aria-label="Alias mode">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent align="end">
                                {(Object.keys(ALIAS_MODES) as AliasMode[]).map((m) => (
                                  <SelectItem key={m} value={m}>
                                    {ALIAS_MODES[m]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground"
                              onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}
                              aria-label="Remove alias"
                            >
                              <X />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setRows((rs) => [...rs, { sub: "", base: rs[0]?.base || defaultBase, mode: "redirect" }])
                    }
                  >
                    <Plus /> Add alias
                  </Button>
                </Section>
              </>
            )}
          </TabsContent>

          <TabsContent value="target" className="space-y-5">
            <Section title="Target" description="The tailnet peer and port your service is listening on.">
              <DevicePicker
                devices={props.devices}
                tag={props.peerTag}
                value={deviceId}
                onChange={setDeviceId}
                fallbackLabel={
                  existing ? `${existing.deviceName} (${existing.targetIp}) — untagged or not in tailnet` : undefined
                }
              />
              <div className="flex gap-2">
                <Select value={scheme} onValueChange={(v) => setScheme(v as "http" | "https")}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">http://</SelectItem>
                    <SelectItem value="https">https://</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="Port, e.g. 8080"
                  className="flex-1"
                />
              </div>
              <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <span className="truncate font-mono text-xs">{firstDomain}</span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                {device || existing ? (
                  <DeviceBadge device={device} name={device?.name ?? existing!.deviceName} className="h-6 text-xs" />
                ) : (
                  <span className="text-xs text-muted-foreground">select a peer</span>
                )}
                <span className="font-mono text-xs text-muted-foreground">
                  {scheme === "https" ? "https " : ""}:{port || "port"}
                </span>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="auth" className="space-y-5">
            <Section
              title="Countries"
              description="Let visitors in by the country of their IP address. The others get 403 Forbidden before any request reaches the service."
              action={
                <Switch
                  checked={countryMode !== "off"}
                  onCheckedChange={(on) => setCountryMode(on ? "allow" : "off")}
                  aria-label="Restrict countries"
                />
              }
            >
              {countryMode !== "off" &&
                (!canRestrictCountries ? (
                  <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
                    <p className="text-sm text-muted-foreground">
                      {props.countryDb?.state === "loading"
                        ? "The country database is still loading."
                        : "The country database isn't loaded yet."}
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={props.onOpenCountries}>
                      <Earth /> Country database
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Select value={countryMode} onValueChange={(v) => setCountryMode(v as CountryMode)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="allow">Only let in visitors from these countries</SelectItem>
                        <SelectItem value="block">Keep out visitors from these countries</SelectItem>
                      </SelectContent>
                    </Select>
                    <CountryPicker
                      available={props.countryDb?.countries ?? []}
                      value={countries}
                      onChange={setCountries}
                    />
                    <p className="text-xs text-muted-foreground">
                      {countryMode === "allow"
                        ? "Addresses without a country, like private networks, are kept out too."
                        : "Addresses without a country, like private networks, get through."}{" "}
                      Traefik asks proxytail about each request, and answers 500 while proxytail is down.
                    </p>
                    {!countryDbReady && (
                      <Alert>
                        <AlertDescription>
                          The country database isn't loaded, so Traefik answers 503 to every request.{" "}
                          <button type="button" className="underline" onClick={props.onOpenCountries}>
                            Country database
                          </button>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                ))}
            </Section>

            <Section
              title="Basic auth"
              description="Ask visitors for a username and password. Credentials are stripped before reaching the service."
              action={<Switch checked={basicAuth} onCheckedChange={toggleBasicAuth} aria-label="Require basic auth" />}
            >
              {basicAuth &&
                (props.basicAuthUsers.length === 0 ? (
                  <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
                    <p className="text-sm text-muted-foreground">You haven't added a user yet.</p>
                    <Button type="button" variant="outline" size="sm" onClick={props.onOpenUsers}>
                      <KeyRound /> Manage users
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Who can sign in</Label>
                    <div className="divide-y rounded-lg border">
                      {props.basicAuthUsers.map((u) => {
                        const id = `user-${u.id}`;
                        return (
                          <label key={u.id} htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                            <Checkbox
                              id={id}
                              checked={userIds.includes(u.id)}
                              onCheckedChange={(v) =>
                                setUserIds((ids) => (v === true ? [...ids, u.id] : ids.filter((x) => x !== u.id)))
                              }
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-sm">{u.username}</span>
                            <span className="text-xs text-muted-foreground">
                              {u.hostIds.length} {u.hostIds.length === 1 ? "service" : "services"}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      A user's password is the same on every service they can sign in to.{" "}
                      <button type="button" className="underline" onClick={props.onOpenUsers}>
                        Manage users
                      </button>
                    </p>
                  </div>
                ))}
            </Section>

            <Section
              title="Client certificates"
              description="Traefik asks visitors for a certificate signed by one of your CAs before any request reaches the service."
              action={
                <Switch
                  checked={clientAuth !== "off"}
                  onCheckedChange={(on) => setClientAuth(on ? "require" : "off")}
                  aria-label="Verify client certificates"
                />
              }
            >
              {clientAuth !== "off" && (
                <div className="space-y-4">
                  {props.clientCas.length === 0 ? (
                    <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
                      <p className="text-sm text-muted-foreground">You haven't added a client CA yet.</p>
                      <Button type="button" variant="outline" size="sm" onClick={props.onOpenClientCas}>
                        <ShieldCheck /> Manage client CAs
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Trusted CAs</Label>
                      <div className="divide-y rounded-lg border">
                        {props.clientCas.map((ca) => {
                          const id = `ca-${ca.id}`;
                          const expired = new Date(ca.summary.notAfter).getTime() < Date.now();
                          return (
                            <label key={ca.id} htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                              <Checkbox
                                id={id}
                                checked={caIds.includes(ca.id)}
                                onCheckedChange={(v) =>
                                  setCaIds((ids) => (v === true ? [...ids, ca.id] : ids.filter((x) => x !== ca.id)))
                                }
                              />
                              <div className="min-w-0 flex-1 leading-tight">
                                <p className="truncate text-sm font-medium">{ca.name}</p>
                                <p className="truncate text-xs text-muted-foreground">CN={ca.summary.subject}</p>
                              </div>
                              {expired && <span className="text-xs text-destructive">Expired</span>}
                            </label>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Any certificate signed by a checked CA is accepted.{" "}
                        <button type="button" className="underline" onClick={props.onOpenClientCas}>
                          Manage client CAs
                        </button>
                      </p>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label>Visitors without a valid certificate</Label>
                    <Select value={clientAuth} onValueChange={(v) => setClientAuth(v as ClientAuth)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="require">Are rejected during the handshake</SelectItem>
                        <SelectItem value="optional">Get through; certificates are verified if presented</SelectItem>
                      </SelectContent>
                    </Select>
                    {clientAuth === "optional" && (
                      <p className="text-xs text-muted-foreground">
                        Useful when the service decides itself, e.g. by forwarding the certificate details below. Invalid
                        certificates are still rejected.
                      </p>
                    )}
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="cert-headers"
                      checked={certHeaders}
                      onCheckedChange={(v) => setCertHeaders(v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-1">
                      <Label htmlFor="cert-headers">Forward certificate details</Label>
                      <p className="text-sm text-muted-foreground">
                        Pass the verified certificate's subject, issuer, serial and validity to the service in the{" "}
                        <code className="font-mono text-xs">X-Forwarded-Tls-Client-Cert-Info</code> header (URL-encoded).
                        A value sent by the client is always dropped.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </Section>

          </TabsContent>

          <TabsContent value="advanced" className="space-y-5">
            <Section
              title="Skip upstream TLS verification"
              description="Connect to the target over https and accept its certificate even if it's self-signed or doesn't match."
              action={
                <Switch
                  checked={scheme === "https" && skipVerify}
                  onCheckedChange={(on) => {
                    setSkipVerify(on);
                    // Verification only exists for https targets, so asking to skip it implies https.
                    if (on) setScheme("https");
                  }}
                  aria-label="Skip upstream TLS verification"
                />
              }
            />

            <Section
              title="Hide from search engines"
              description={
                <>
                  Sends <code className="font-mono text-xs">X-Robots-Tag: noindex, nofollow</code>, so search engines
                  don't list the service. It doesn't keep anyone out.
                </>
              }
              action={<Switch checked={noIndex} onCheckedChange={setNoIndex} aria-label="Hide from search engines" />}
            />
          </TabsContent>
        </div>
      </Tabs>

      <div className="space-y-3 border-t px-6 py-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">Traefik applies changes within ~5 seconds.</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {existing ? "Save changes" : "Create service"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
