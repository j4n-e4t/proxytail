import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe, KeyRound, Loader2, Plus, Server, Trash2, X, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TraefikIcon } from "@/components/brand-icons";
import { DeviceBadge } from "@/components/device-badge";
import { DevicePicker } from "@/components/device-picker";
import { OsIcon } from "@/components/os-icon";
import { PageHeader } from "@/components/page-header";
import { serviceState, StateTile } from "@/components/status";
import { api, type Device, type Domain, type ProxyHost, type ProxyHostDraft, type TraefikStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

interface EditorProps {
  devices: Device[];
  peerTag: string;
  domains: Domain[] | null;
  traefik: TraefikStatus | null;
  onOpenDomains: () => void;
  onCancel: () => void;
  onSaved: () => void;
}

/** Create (`hostId` null) or edit a service. `hosts` and `domains` are `null` while still loading. */
export function ServiceEditorPage(
  props: EditorProps & { hosts: ProxyHost[] | null; hostId: number | null; initialDeviceId?: string },
) {
  if (props.domains === null || (props.hostId !== null && props.hosts === null)) {
    return (
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const existing = props.hostId !== null ? props.hosts?.find((h) => h.id === props.hostId) : undefined;
  if (props.hostId !== null && !existing) {
    return (
      <div className="max-w-3xl">
        <BackLink onClick={props.onCancel} />
        <PageHeader title="Service not found" description={`There is no service with id ${props.hostId}.`} />
      </div>
    );
  }
  return (
    // Keyed so the form state resets when switching between services.
    <ServiceForm
      key={existing?.id ?? "new"}
      {...props}
      domains={props.domains}
      existing={existing ?? null}
      initialDeviceId={props.initialDeviceId}
    />
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="link" className="mb-2 h-auto px-0 text-muted-foreground" onClick={onClick}>
      <ArrowLeft /> Services
    </Button>
  );
}

interface DomainRow {
  sub: string;
  base: string;
}

/** Split a hostname into subdomain + base, preferring registered domains (longest match). */
function splitHostname(hostname: string, domains: Domain[]): DomainRow {
  const match = domains
    .filter((d) => hostname === d.name || hostname.endsWith(`.${d.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const base = match?.name ?? hostname.split(".").slice(1).join(".");
  return { sub: hostname === base ? "" : hostname.slice(0, -(base.length + 1)), base };
}

const joinHostname = ({ sub, base }: DomainRow) => (sub.trim() ? `${sub.trim().toLowerCase()}.${base}` : base);

interface UserRow {
  /** Stable React key. */
  key: number;
  username: string;
  password: string;
  /** Username as stored on the server; unset for new users. */
  previous?: string;
}

let nextKey = 0;

function ServiceForm(
  props: EditorProps & { domains: Domain[]; existing: ProxyHost | null; initialDeviceId?: string },
) {
  const { existing } = props;
  const verified = props.domains.filter((d) => d.verified);
  const defaultBase = verified[0]?.name ?? "";
  const [rows, setRows] = useState<DomainRow[]>(() =>
    existing ? existing.domains.map((h) => splitHostname(h, props.domains)) : [{ sub: "", base: defaultBase }],
  );
  const [deviceId, setDeviceId] = useState(existing?.deviceId ?? props.initialDeviceId ?? "");
  const [port, setPort] = useState(existing ? String(existing.targetPort) : "");
  const [scheme, setScheme] = useState<"http" | "https">(existing?.scheme ?? "http");
  const [skipVerify, setSkipVerify] = useState(existing?.insecureSkipVerify ?? false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [basicAuth, setBasicAuth] = useState(existing?.basicAuth ?? false);
  const [healthCheck, setHealthCheck] = useState(existing?.healthCheck ?? true);
  const [healthPath, setHealthPath] = useState(existing?.healthCheckPath ?? "/");
  const [users, setUsers] = useState<UserRow[]>(
    () => existing?.basicAuthUsers.map((u) => ({ key: nextKey++, username: u.username, password: "", previous: u.username })) ?? [],
  );
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
  const setUser = (key: number, patch: Partial<UserRow>) =>
    setUsers((us) => us.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  const addUser = () => setUsers((us) => [...us, { key: nextKey++, username: "", password: "" }]);

  const toggleBasicAuth = (on: boolean) => {
    setBasicAuth(on);
    if (on && !users.length) addUser();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!deviceId) return setError("Pick the tailnet peer that runs this service.");
    if (rows.some((r) => !r.base)) return setError("Pick a domain for every hostname.");
    const draft: ProxyHostDraft = {
      domains: rows.map(joinHostname),
      deviceId,
      targetPort: Number(port),
      scheme,
      insecureSkipVerify: scheme === "https" && skipVerify,
      enabled,
      basicAuth,
      healthCheck,
      healthCheckPath: healthPath.trim() || "/",
      basicAuthUsers: users
        .filter((u) => u.username.trim() || u.password)
        .map((u) => ({ username: u.username.trim(), password: u.password || undefined, previous: u.previous })),
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

  return (
    <form onSubmit={submit}>
      <BackLink onClick={props.onCancel} />
      <PageHeader
        title={existing ? existing.domains[0]! : "New service"}
        description={
          existing ? (
            <>
              Traefik router <code className="font-mono">proxytail-host-{existing.id}@http</code>
            </>
          ) : (
            "Expose a service on your tailnet through Traefik."
          )
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start 2xl:grid-cols-[minmax(0,52rem)_24rem]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Domains</CardTitle>
            <CardDescription>Choose a subdomain on one of your verified domains.</CardDescription>
          </CardHeader>
          <CardContent>
            {baseOptions.length === 0 ? (
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
            ) : (
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="flex gap-2">
                    <div className="flex flex-1">
                      <Input
                        autoFocus={i === 0 && !existing}
                        value={r.sub}
                        onChange={(e) => setRow(i, { sub: e.target.value.replace(/\s/g, "") })}
                        placeholder="app"
                        aria-label="Subdomain"
                        className="h-10 flex-1 rounded-r-none font-mono focus-visible:z-10"
                      />
                      <Select value={r.base} onValueChange={(base) => setRow(i, { base })}>
                        <SelectTrigger
                          aria-label="Domain"
                          className="h-10! max-w-[55%] min-w-40 rounded-l-none border-l-0 bg-muted/40 font-mono"
                        >
                          <span className="truncate">{r.base ? `.${r.base}` : "Select domain"}</span>
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
                    {rows.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-10 text-muted-foreground"
                        onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                        aria-label="Remove hostname"
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Leave the subdomain empty to use the domain itself.</p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 w-full border-dashed bg-transparent text-muted-foreground"
                  onClick={() => setRows((rs) => [...rs, { sub: "", base: rs.at(-1)?.base ?? defaultBase }])}
                >
                  <Plus /> Add hostname
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Target</CardTitle>
            <CardDescription>The tailnet peer and port your service is listening on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
                <SelectTrigger className="h-10! w-28">
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
                className="h-10 flex-1"
                required
              />
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 xl:hidden">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Health check</CardTitle>
            <CardDescription>
              Traefik requests this path every 10 seconds. Any 2xx or 3xx answer counts as healthy; otherwise the
              service is flagged and visitors get a 503 until it recovers.
            </CardDescription>
            <CardAction>
              <Switch checked={healthCheck} onCheckedChange={setHealthCheck} aria-label="Enable health check" />
            </CardAction>
          </CardHeader>
          {healthCheck && (
            <CardContent>
              <div className="flex">
                <span className="flex h-10 max-w-[55%] items-center truncate rounded-l-md border border-r-0 bg-muted/40 px-3 font-mono text-sm text-muted-foreground">
                  {scheme}://{device?.ipv4 ?? existing?.targetIp ?? "peer"}:{port || "port"}
                </span>
                <Input
                  value={healthPath}
                  onChange={(e) => setHealthPath(e.target.value.replace(/\s/g, ""))}
                  placeholder="/"
                  aria-label="Health check path"
                  className="h-10 flex-1 rounded-l-none font-mono"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Use a path that doesn't require login, e.g. <code className="font-mono">/health</code>, if the root
                page answers 401 or 404.
              </p>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Basic auth</CardTitle>
            <CardDescription>
              Ask visitors for a username and password before Traefik forwards the request. Credentials are stripped
              before reaching the service.
            </CardDescription>
            <CardAction>
              <Switch checked={basicAuth} onCheckedChange={toggleBasicAuth} aria-label="Require basic auth" />
            </CardAction>
          </CardHeader>
          {basicAuth && (
            <CardContent className="space-y-2">
              <div className="grid grid-cols-[1fr_1fr_2.5rem] gap-2 text-xs font-medium text-muted-foreground">
                <span>Username</span>
                <span>Password</span>
              </div>
              {users.map((u) => (
                <div key={u.key} className="grid grid-cols-[1fr_1fr_2.5rem] gap-2">
                  <Input
                    value={u.username}
                    onChange={(e) => setUser(u.key, { username: e.target.value.replace(/[\s:]/g, "") })}
                    placeholder="alice"
                    aria-label="Username"
                    autoComplete="off"
                    className="h-10 font-mono"
                  />
                  <Input
                    type="password"
                    value={u.password}
                    onChange={(e) => setUser(u.key, { password: e.target.value })}
                    placeholder={u.previous ? "•••••••• (unchanged)" : "At least 8 characters"}
                    aria-label="Password"
                    autoComplete="new-password"
                    className="h-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 text-muted-foreground"
                    onClick={() => setUsers((us) => us.filter((x) => x.key !== u.key))}
                    aria-label={`Remove ${u.username || "user"}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full border-dashed bg-transparent text-muted-foreground"
                onClick={addUser}
              >
                <Plus /> Add user
              </Button>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="size-3" /> Passwords are stored as bcrypt hashes and can't be shown again.
              </p>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Advanced</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-1">
                <Label htmlFor="enabled">Enabled</Label>
                <p className="text-sm text-muted-foreground">Disabled services are removed from Traefik but kept here.</p>
              </div>
              <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="flex items-start gap-3 border-t pt-4 has-disabled:opacity-60">
              <Checkbox
                id="skip-verify"
                checked={scheme === "https" && skipVerify}
                disabled={scheme !== "https"}
                onCheckedChange={(v) => setSkipVerify(v === true)}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor="skip-verify">Skip upstream TLS verification</Label>
                <p className="text-sm text-muted-foreground">
                  Accept self-signed certificates from the target. Only applies to https targets.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Wide screens: a live summary of the route next to the form, with the form's actions. */}
      <aside className="sticky top-8 hidden space-y-4 xl:block">
        {existing && <StatusCard host={existing} traefik={props.traefik} />}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Route</CardTitle>
          </CardHeader>
          <CardContent>
            <ol>
              <RouteStep icon={Globe} label="Visitors open">
                {rows.map((r, i) => (
                  <p key={i} className="truncate font-mono text-sm">
                    {r.base ? joinHostname(r) : <span className="text-muted-foreground">no domain yet</span>}
                  </p>
                ))}
              </RouteStep>
              <RouteStep icon={TraefikIcon} label="Traefik applies">
                <ul className="space-y-0.5 text-sm">
                  <li>HTTPS with Let's Encrypt</li>
                  <li className={cn(!basicAuth && "text-muted-foreground")}>
                    {basicAuth
                      ? `Basic auth · ${users.length} ${users.length === 1 ? "user" : "users"}`
                      : "No login required"}
                  </li>
                  <li className={cn(!healthCheck && "text-muted-foreground")}>
                    {healthCheck ? (
                      <>
                        Health check on <code className="font-mono">{healthPath.trim() || "/"}</code>
                      </>
                    ) : (
                      "No health check"
                    )}
                  </li>
                  {!enabled && <li className="text-warning">Disabled: not routed</li>}
                </ul>
              </RouteStep>
              <RouteStep icon={Server} osIcon={device?.os} label="and forwards to" last>
                {device || existing ? (
                  <DeviceBadge device={device} name={device?.name ?? existing!.deviceName} className="h-6 text-xs" />
                ) : (
                  <p className="text-sm text-muted-foreground">No peer selected</p>
                )}
                <p className="font-mono text-xs text-muted-foreground">
                  {scheme}://{device?.ipv4 ?? existing?.targetIp ?? "peer"}:{port || "port"}
                </p>
              </RouteStep>
            </ol>
          </CardContent>
        </Card>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {existing ? "Save changes" : "Create service"}
          </Button>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <p className="text-center text-xs text-muted-foreground">Traefik applies changes within ~5 seconds.</p>
        </div>
      </aside>
      </div>

      <div className="sticky bottom-0 mt-6 -mb-8 space-y-3 border-t bg-background/95 py-4 backdrop-blur xl:hidden">
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

function StatusCard({ host, traefik }: { host: ProxyHost; traefik: TraefikStatus | null }) {
  const state = serviceState(host, traefik);
  return (
    <Card className="flex-row items-start gap-3 px-6">
      <StateTile state={state} />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{state.label}</p>
        <p className="text-xs text-muted-foreground">{state.detail}</p>
      </div>
    </Card>
  );
}

/** One hop of the route summary, joined to the next by a vertical line. */
function RouteStep(props: {
  icon: LucideIcon | typeof TraefikIcon;
  /** Shows the peer's OS icon instead of `icon`. */
  osIcon?: string;
  label: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <li className={cn("relative flex gap-3", !props.last && "pb-5")}>
      {!props.last && <span className="absolute top-9 bottom-1 left-4 w-px bg-border" aria-hidden />}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
        {props.osIcon !== undefined ? <OsIcon os={props.osIcon} className="size-3.5" /> : <Icon className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1 pt-1">
        <p className="text-xs text-muted-foreground">{props.label}</p>
        {props.children}
      </div>
    </li>
  );
}
