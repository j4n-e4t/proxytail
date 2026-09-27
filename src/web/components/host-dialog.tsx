import { useState, type FormEvent } from "react";
import { ArrowRight, Globe, Loader2, Plus, Settings2, Waypoints, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeviceBadge } from "@/components/device-badge";
import { DevicePicker } from "@/components/device-picker";
import { api, type Device, type Domain, type ProxyHost, type ProxyHostDraft } from "@/lib/api";

export type HostDialogInitial = ProxyHost | Partial<ProxyHostDraft>;

interface DialogProps {
  devices: Device[];
  domains: Domain[];
  onOpenDomains: () => void;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function HostDialog(props: DialogProps & { initial: HostDialogInitial | null }) {
  return (
    <Dialog open={!!props.initial} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        {props.initial && (
          // Keyed so the form state resets whenever a different host is opened.
          <HostForm key={"id" in props.initial ? props.initial.id : "new"} {...props} initial={props.initial} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-sm font-semibold">{title}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
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

function HostForm(props: DialogProps & { initial: HostDialogInitial }) {
  const existing = "id" in props.initial ? (props.initial as ProxyHost) : null;
  const verified = props.domains.filter((d) => d.verified);
  const defaultBase = verified[0]?.name ?? "";
  const [rows, setRows] = useState<DomainRow[]>(() =>
    props.initial.domains?.length
      ? props.initial.domains.map((h) => splitHostname(h, props.domains))
      : [{ sub: "", base: defaultBase }],
  );
  const [deviceId, setDeviceId] = useState(props.initial.deviceId ?? "");
  const [port, setPort] = useState(props.initial.targetPort ? String(props.initial.targetPort) : "");
  const [scheme, setScheme] = useState<"http" | "https">(props.initial.scheme ?? "http");
  const [skipVerify, setSkipVerify] = useState(props.initial.insecureSkipVerify ?? false);
  const [enabled, setEnabled] = useState(props.initial.enabled ?? true);
  const [tab, setTab] = useState("service");
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!deviceId) {
      setTab("service");
      return setError("Pick the tailnet device that runs this service.");
    }
    setSaving(true);
    if (rows.some((r) => !r.base)) {
      setTab("service");
      setSaving(false);
      return setError("Pick a domain for every hostname.");
    }
    const draft: ProxyHostDraft = {
      domains: rows.map(joinHostname),
      deviceId,
      targetPort: Number(port),
      scheme,
      insecureSkipVerify: scheme === "https" && skipVerify,
      enabled,
    };
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
      <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          <Waypoints className="size-5" />
        </div>
        <div className="space-y-1">
          <DialogTitle>{existing ? "Edit service" : "New service"}</DialogTitle>
          <DialogDescription>Expose a service on your tailnet through Traefik.</DialogDescription>
        </div>
      </DialogHeader>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="border-b px-6">
          <TabsList variant="line" className="h-10 gap-4 p-0">
            <TabsTrigger value="service" className="px-0">
              <Globe /> Service
            </TabsTrigger>
            <TabsTrigger value="advanced" className="px-0">
              <Settings2 /> Advanced
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="service" className="space-y-6 px-6 py-5">
          <Section title="Domains" description="Choose a subdomain on one of your verified domains.">
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
          </Section>

          <Section title="Target" description="The tailnet device and port your service is listening on.">
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <DevicePicker
                devices={props.devices}
                value={deviceId}
                onChange={setDeviceId}
                fallbackLabel={existing ? `${existing.deviceName} (${existing.targetIp}) — not in tailnet` : undefined}
              />
              <div className="flex gap-2">
                <Select value={scheme} onValueChange={(v) => setScheme(v as "http" | "https")}>
                  <SelectTrigger className="h-10! w-28 bg-background">
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
                  className="h-10 flex-1 bg-background"
                  required
                />
              </div>
              <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-3 py-2">
                <span className="truncate font-mono text-xs">{firstDomain}</span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                {device || existing ? (
                  <DeviceBadge
                    device={device}
                    name={device?.name ?? existing!.deviceName}
                    className="h-6 text-xs"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">select a device</span>
                )}
                <span className="font-mono text-xs text-muted-foreground">
                  {scheme === "https" ? "https " : ""}:{port || "port"}
                </span>
              </div>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 px-6 py-5">
          <div className="flex items-start justify-between gap-6 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="enabled">Enabled</Label>
              <p className="text-sm text-muted-foreground">Disabled services are removed from Traefik but kept here.</p>
            </div>
            <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-4 has-disabled:opacity-60">
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
          {existing && (
            <p className="text-xs text-muted-foreground">
              Traefik router: <code className="font-mono">proxytail-host-{existing.id}@http</code>
            </p>
          )}
        </TabsContent>
      </Tabs>

      {error && (
        <div className="px-6 pb-4">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <DialogFooter className="items-center border-t px-6 py-4 sm:justify-between">
        <p className="hidden text-xs text-muted-foreground sm:block">Traefik applies changes within ~5 seconds.</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {existing ? "Save changes" : "Create service"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
