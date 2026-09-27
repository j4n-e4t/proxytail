import { Fragment, useEffect, useState, type FormEvent } from "react";
import {
  Download,
  FileBadge,
  Info,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status";
import { api, type CertSummary, type ClientCa, type ClientCert, type IssuedCert, type ProxyHost } from "@/lib/api";
import { cn } from "@/lib/utils";

const CA_VALIDITY = [
  ["1825", "5 years"],
  ["3650", "10 years"],
  ["7300", "20 years"],
] as const;

const CERT_VALIDITY = [
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
  ["730", "2 years"],
  ["1825", "5 years"],
] as const;

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A random password without look-alike characters, for the PKCS#12 bundle. */
function randomPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(20)), (n) => alphabet[n % alphabet.length]).join("");
}

function daysLeft(iso: string) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Expiry with a colour: red once expired, amber within 30 days. */
function Expiry({ notAfter }: { notAfter: string }) {
  const days = daysLeft(notAfter);
  return (
    <span
      className={cn("text-sm", days < 0 ? "text-destructive" : days <= 30 ? "text-warning" : "text-muted-foreground")}
      title={new Date(notAfter).toLocaleString()}
    >
      {days < 0 ? `Expired ${formatDate(notAfter)}` : `${formatDate(notAfter)} · ${days}d`}
    </span>
  );
}

function Detail({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className={cn("truncate", mono && "font-mono text-xs")} title={value}>
          {value}
        </span>
        {copy && <CopyButton text={value} />}
      </span>
    </div>
  );
}

function CertDetails({ summary }: { summary: CertSummary }) {
  return (
    <div className="space-y-1.5">
      <Detail label="Subject" value={summary.subject} />
      <Detail label="Issuer" value={summary.issuer} />
      <Detail label="Valid from" value={new Date(summary.notBefore).toLocaleString()} />
      <Detail label="Valid until" value={new Date(summary.notAfter).toLocaleString()} />
      <Detail label="Serial" value={summary.serial} mono copy />
      <Detail label="SHA-256" value={summary.fingerprint} mono copy />
    </div>
  );
}

const textareaClass =
  "min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

function AddCaDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (ca: ClientCa) => void }) {
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [name, setName] = useState("");
  const [days, setDays] = useState("3650");
  const [pem, setPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setPem("");
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ca = await api.createClientCa(
        mode === "generate" ? { mode, name, days: Number(days) } : { mode, name, pem },
      );
      toast.success(mode === "generate" ? `Created ${ca.name}` : `Imported ${ca.name}`);
      props.onAdded(ca);
      reset();
      props.onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setPem(await file.text());
    if (!name) setName(file.name.replace(/\.(pem|crt|cer)$/i, ""));
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <ShieldCheck className="size-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Add client CA</DialogTitle>
              <DialogDescription>Services can require client certificates signed by it.</DialogDescription>
            </div>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="space-y-4 px-6 pb-5">
            <TabsList className="w-full">
              <TabsTrigger value="generate">Generate</TabsTrigger>
              <TabsTrigger value="import">Import</TabsTrigger>
            </TabsList>

            <div className="grid gap-2">
              <Label htmlFor="ca-name">Name</Label>
              <Input
                id="ca-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Family devices"
                maxLength={64}
                className="h-10"
                required
              />
            </div>

            <TabsContent value="generate" className="space-y-4">
              <div className="grid gap-2">
                <Label>Validity</Label>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CA_VALIDITY.map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">
                proxytail creates an RSA 4096 root CA and keeps its key, so you can issue client certificates from it
                here. Only the certificate is handed to Traefik.
              </p>
            </TabsContent>

            <TabsContent value="import" className="space-y-2">
              <div className="flex items-end justify-between">
                <Label htmlFor="ca-pem">CA certificate (PEM)</Label>
                <Button type="button" variant="outline" size="xs" asChild>
                  <label className="cursor-pointer">
                    <Upload /> Choose file
                    <input
                      type="file"
                      accept=".pem,.crt,.cer,application/x-pem-file"
                      className="sr-only"
                      onChange={(e) => readFile(e.target.files?.[0])}
                    />
                  </label>
                </Button>
              </div>
              <textarea
                id="ca-pem"
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
                className={textareaClass}
                spellCheck={false}
                required={mode === "import"}
              />
              <p className="text-sm text-muted-foreground">
                Use a CA you already issue client certificates with. Only the certificate is needed, never its key, so
                certificates for it are issued elsewhere. A bundle with intermediates is fine.
              </p>
            </TabsContent>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </Tabs>

          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || (mode === "import" && !pem.trim())}>
              {busy && <Loader2 className="animate-spin" />}
              {mode === "generate" ? (busy ? "Generating…" : "Generate CA") : "Import CA"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IssueDialog(props: { ca: ClientCa | null; onOpenChange: (open: boolean) => void; onIssued: () => void }) {
  const [commonName, setCommonName] = useState("");
  const [days, setDays] = useState("365");
  const [password, setPassword] = useState(randomPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCert | null>(null);

  const close = () => {
    props.onOpenChange(false);
    // Reset after the close animation.
    setTimeout(() => {
      setIssued(null);
      setCommonName("");
      setPassword(randomPassword());
      setError(null);
    }, 200);
  };

  const downloadP12 = (c: IssuedCert) =>
    download(`${c.fileName}.p12`, Uint8Array.from(atob(c.p12), (ch) => ch.charCodeAt(0)), "application/x-pkcs12");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!props.ca) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.issueClientCert(props.ca.id, { commonName, days: Number(days), password });
      setIssued(c);
      downloadP12(c);
      props.onIssued();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!props.ca} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <FileBadge className="size-5" />
          </div>
          <div className="space-y-1">
            <DialogTitle>{issued ? "Certificate issued" : "Issue client certificate"}</DialogTitle>
            <DialogDescription>Signed by {props.ca?.name}.</DialogDescription>
          </div>
        </DialogHeader>

        {issued ? (
          <>
            <div className="space-y-4 px-6 pb-5">
              <Alert>
                <KeyRound />
                <AlertDescription>
                  The private key isn't stored. Download what you need now: it can't be downloaded again.
                </AlertDescription>
              </Alert>
              <div className="space-y-2">
                <p className="text-sm font-medium">PKCS#12 bundle</p>
                <p className="text-sm text-muted-foreground">
                  Import it into the browser, keychain or phone that should get access. It contains the key, the
                  certificate and the CA, protected by this password:
                </p>
                <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
                  <span className="flex-1 truncate">{password}</span>
                  <CopyButton text={password} />
                </div>
                <Button type="button" variant="outline" className="w-full" onClick={() => downloadP12(issued)}>
                  <Download /> {issued.fileName}.p12
                </Button>
              </div>
              <div className="space-y-2 border-t pt-4">
                <p className="text-sm font-medium">PEM files</p>
                <p className="text-sm text-muted-foreground">
                  For curl and other tools: <code className="font-mono text-xs">--cert {issued.fileName}.crt --key{" "}
                  {issued.fileName}.key</code>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => download(`${issued.fileName}.crt`, issued.certPem, "application/x-pem-file")}
                  >
                    <Download /> Certificate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => download(`${issued.fileName}.key`, issued.keyPem, "application/x-pem-file")}
                  >
                    <Download /> Private key
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter className="border-t px-6 py-4">
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="space-y-4 px-6 pb-5">
              <div className="grid gap-2">
                <Label htmlFor="cert-cn">Common name</Label>
                <Input
                  id="cert-cn"
                  autoFocus
                  value={commonName}
                  onChange={(e) => setCommonName(e.target.value)}
                  placeholder="alice-laptop"
                  maxLength={64}
                  className="h-10"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Who or which device holds it. Services can read it when certificate details are forwarded.
                </p>
              </div>
              <div className="grid gap-2">
                <Label>Validity</Label>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CERT_VALIDITY.map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cert-password">Bundle password</Label>
                <div className="flex gap-2">
                  <Input
                    id="cert-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                    className="h-10 font-mono"
                    minLength={8}
                    required
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-lg"
                    aria-label="Generate password"
                    title="Generate password"
                    onClick={() => setPassword(randomPassword())}
                  >
                    <RefreshCw />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Protects the .p12 file. You'll need it to import it.</p>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
            <DialogFooter className="border-t px-6 py-4">
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !commonName.trim() || password.length < 8}>
                {busy && <Loader2 className="animate-spin" />} Issue & download
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog(props: { ca: ClientCa | null; onOpenChange: (open: boolean) => void; onRenamed: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.ca) setName(props.ca.name);
    setError(null);
  }, [props.ca]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!props.ca) return;
    try {
      await api.renameClientCa(props.ca.id, name);
      props.onRenamed();
      props.onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog open={!!props.ca} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename CA</DialogTitle>
            <DialogDescription>Only changes the name shown here, not the certificate.</DialogDescription>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className="h-10" required />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IssuedCerts({ ca, onIssue, onForget }: { ca: ClientCa; onIssue: () => void; onForget: (c: ClientCert) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Issued certificates</p>
        <Button size="xs" variant="outline" onClick={onIssue}>
          <Plus /> Issue
        </Button>
      </div>
      {ca.clientCerts.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <div className="divide-y rounded-lg border bg-background">
          {ca.clientCerts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2">
              <FileBadge className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium">{c.summary.subject}</p>
                <p className="truncate font-mono text-xs text-muted-foreground" title={c.summary.fingerprint}>
                  {c.summary.serial}
                </p>
              </div>
              <Expiry notAfter={c.summary.notAfter} />
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={`Forget ${c.summary.subject}`}
                title="Remove from this list"
                onClick={() => onForget(c)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="flex gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3 shrink-0" />
        Traefik doesn't check revocation, so a certificate stays valid until it expires, even when removed from this
        list. To cut off a lost device, move services to a new CA and reissue the remaining certificates.
      </p>
    </div>
  );
}

export function ClientCasPage(props: {
  cas: ClientCa[] | null;
  hosts: ProxyHost[];
  onChanged: () => void;
  onOpenService: (id: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [issuing, setIssuing] = useState<ClientCa | null>(null);
  const [renaming, setRenaming] = useState<ClientCa | null>(null);
  const [deleting, setDeleting] = useState<ClientCa | null>(null);
  const [forgetting, setForgetting] = useState<ClientCert | null>(null);
  const hostById = new Map(props.hosts.map((h) => [h.id, h]));

  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast.success(success);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Client CAs"
        description="Certificate authorities for mutual TLS. Services can require visitors to present a certificate signed by one of them."
      >
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add CA
        </Button>
      </PageHeader>

      <Card className="gap-0 py-0">
        {props.cas === null ? (
          <div className="space-y-3 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : props.cas.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
              <ShieldCheck className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No client CAs yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Generate a CA to issue client certificates for your devices, or import one you already use. Then turn
                on client certificates for a service.
              </p>
            </div>
            <Button onClick={() => setAdding(true)} className="mt-2">
              <Plus /> Add CA
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">CA</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.cas.map((ca) => (
                <Fragment key={ca.id}>
                  <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === ca.id ? null : ca.id)}>
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-primary/10 text-primary">
                          <ShieldCheck className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{ca.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            CN={ca.summary.subject}
                            {ca.certCount > 1 && ` · ${ca.certCount} certificates`}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {ca.generated ? (
                        <ToneBadge t="success">
                          <KeyRound className="size-3" /> Generated
                        </ToneBadge>
                      ) : (
                        <ToneBadge t="muted">
                          <Upload className="size-3" /> Imported
                        </ToneBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Expiry notAfter={ca.summary.notAfter} />
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{ca.hostIds.length}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {ca.generated ? ca.clientCerts.length : "—"}
                    </TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          {ca.generated && (
                            <DropdownMenuItem onSelect={() => setIssuing(ca)}>
                              <FileBadge /> Issue certificate
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem asChild>
                            <a href={`/api/client-cas/${ca.id}/cert.pem`} download>
                              <Download /> Download CA certificate
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRenaming(ca)}>
                            <Pencil /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(ca)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                  {expanded === ca.id && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={6} className="px-4 py-4 whitespace-normal">
                        <div className="grid gap-6 md:grid-cols-2">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <p className="text-sm font-medium">Certificate</p>
                              <CertDetails summary={ca.summary} />
                            </div>
                            <div className="space-y-2">
                              <p className="text-sm font-medium">Used by</p>
                              {ca.hostIds.length ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {ca.hostIds.map((id) => (
                                    <Button key={id} size="xs" variant="outline" onClick={() => props.onOpenService(id)}>
                                      {hostById.get(id)?.domains[0] ?? `Service ${id}`}
                                    </Button>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  No service yet. Turn on client certificates in a service's settings.
                                </p>
                              )}
                            </div>
                          </div>
                          {ca.generated ? (
                            <IssuedCerts ca={ca} onIssue={() => setIssuing(ca)} onForget={setForgetting} />
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm font-medium">Issued certificates</p>
                              <p className="text-sm text-muted-foreground">
                                This CA was imported without its key. Issue client certificates wherever its key lives;
                                every certificate it signs is accepted.
                              </p>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <AddCaDialog open={adding} onOpenChange={setAdding} onAdded={(ca) => (props.onChanged(), setExpanded(ca.id))} />
      <IssueDialog ca={issuing} onOpenChange={(o) => !o && setIssuing(null)} onIssued={props.onChanged} />
      <RenameDialog ca={renaming} onOpenChange={(o) => !o && setRenaming(null)} onRenamed={props.onChanged} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.generated
                ? "Its private key is deleted too, so no more certificates can be issued from it. "
                : ""}
              CAs still used by services can't be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && run(() => api.deleteClientCa(deleting.id), `Deleted ${deleting.name}`)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!forgetting} onOpenChange={(o) => !o && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {forgetting?.summary.subject} from the list?</AlertDialogTitle>
            <AlertDialogDescription>
              This doesn't revoke it: Traefik keeps accepting the certificate until it expires on{" "}
              {forgetting && formatDate(forgetting.summary.notAfter)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                forgetting && run(() => api.deleteClientCert(forgetting.id), `Removed ${forgetting.summary.subject}`)
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
