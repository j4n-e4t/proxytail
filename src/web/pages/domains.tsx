import { Fragment, useState, type FormEvent } from "react";
import { Check, Globe, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/copy-button";
import { PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status";
import { api, type Domain } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

/** The DNS record to create, laid out like a DNS provider's record form. */
function RecordTable({ record }: { record: NonNullable<Domain["record"]> }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-[5rem_1fr_1fr] border-b bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span>Type</span>
        <span>Name</span>
        <span>Value</span>
      </div>
      <div className="grid grid-cols-[5rem_1fr_1fr] items-center px-3 py-2 font-mono text-sm">
        <span>{record.type}</span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{record.name}</span>
          <CopyButton text={record.name} />
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{record.value}</span>
          <CopyButton text={record.value} />
        </span>
      </div>
    </div>
  );
}

function CheckResult({ domain }: { domain: Domain }) {
  const c = domain.lastCheck;
  if (!c) return null;
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Wildcard (*.{domain.name})</span>
        <span className={cn("font-mono text-xs", c.ok ? "text-success" : "text-destructive")}>
          {c.wildcard.found.length ? c.wildcard.found.join(", ") : "no record"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Apex ({domain.name}) · optional</span>
        <span className={cn("font-mono text-xs", c.apex.ok ? "text-success" : "text-muted-foreground")}>
          {c.apex.found.length ? c.apex.found.join(", ") : "no record"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Expected</span>
        <span className="font-mono text-xs">{c.expected.join(", ") || "—"}</span>
      </div>
    </div>
  );
}

function AddDomainDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicAddress: string;
  onAdded: (d: Domain) => void;
  onOpenSettings: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim().toLowerCase().replace(/^\*\./, "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.addDomain(clean);
      props.onAdded(d);
      setName("");
      props.onOpenChange(false);
      if (d.verified) toast.success(`${d.name} verified`, { description: "DNS points at your proxy." });
      else toast.warning(`${d.name} added, DNS not verified yet`, { description: d.lastCheck?.error });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const type = /^[\d.]+$/.test(props.publicAddress) ? "A" : props.publicAddress.includes(":") ? "AAAA" : "CNAME";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Globe className="size-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Add domain</DialogTitle>
              <DialogDescription>Services can use any subdomain of a verified domain.</DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-5 px-6 pb-5">
            <div className="grid gap-2">
              <Label htmlFor="domain-name">Domain</Label>
              <Input
                id="domain-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="example.com"
                className="h-10 font-mono"
                required
              />
            </div>

            {props.publicAddress ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Create this record at your DNS provider. It's checked against public resolvers when you add the
                  domain.
                </p>
                <RecordTable
                  record={{ type, name: `*.${clean || "example.com"}`, value: props.publicAddress }}
                />
              </div>
            ) : (
              <Alert>
                <TriangleAlert />
                <AlertTitle>No public address set</AlertTitle>
                <AlertDescription>
                  <p>
                    Set the proxy's public IP in{" "}
                    <button type="button" className="underline" onClick={props.onOpenSettings}>
                      Settings
                    </button>{" "}
                    so the domain's DNS can be verified.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !clean}>
              {busy && <Loader2 className="animate-spin" />} {busy ? "Checking DNS…" : "Add & verify"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DomainsPage(props: {
  domains: Domain[] | null;
  publicAddress: string;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Domain | null>(null);

  const verify = async (d: Domain) => {
    setChecking(d.id);
    try {
      const r = await api.verifyDomain(d.id);
      if (r.verified) toast.success(`${r.name} verified`);
      else toast.error(`${r.name} not verified`, { description: r.lastCheck?.error });
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(null);
    }
  };

  const remove = async (d: Domain) => {
    try {
      await api.deleteDomain(d.id);
      toast.success(`Removed ${d.name}`);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Domains" description="Domains you own. Services pick a subdomain of a verified domain.">
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add domain
        </Button>
      </PageHeader>

      {!props.publicAddress && (
        <Alert className="mb-4">
          <TriangleAlert />
          <AlertTitle>Set your proxy's public address</AlertTitle>
          <AlertDescription>
            <p>
              Domains are verified by checking that <code className="font-mono">*.domain</code> resolves to it.{" "}
              <button className="underline" onClick={props.onOpenSettings}>
                Open settings
              </button>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        {props.domains === null ? (
          <div className="space-y-3 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : props.domains.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
              <Globe className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No domains yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Add a domain and point a wildcard record at your proxy to start creating services on it.
              </p>
            </div>
            <Button onClick={() => setAdding(true)} className="mt-2">
              <Plus /> Add domain
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Domain</TableHead>
                <TableHead>DNS</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.domains.map((d) => (
                <Fragment key={d.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  >
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-primary/10 text-primary">
                          <Globe className="size-4" />
                        </div>
                        <div>
                          <p className="font-medium">{d.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">*.{d.name}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {d.verified ? (
                        <ToneBadge t="success">
                          <Check className="size-3" /> Verified
                        </ToneBadge>
                      ) : (
                        <ToneBadge t="warning">Pending DNS</ToneBadge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{d.hostCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.lastCheck ? timeAgo(d.lastCheck.checkedAt) : "never"}
                    </TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Actions">
                            {checking === d.id ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => verify(d)}>
                            <RefreshCw /> Check DNS
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(d)}>
                            <Trash2 /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                  {(expanded === d.id || !d.verified) && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={5} className="px-4 py-4 whitespace-normal">
                        <div className="grid gap-6 md:grid-cols-2">
                          <div className="space-y-2">
                            <p className="text-sm font-medium">Required record</p>
                            {d.record ? (
                              <RecordTable record={d.record} />
                            ) : (
                              <p className="text-sm text-muted-foreground">Set a public address first.</p>
                            )}
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium">Last check</p>
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => verify(d)}
                                disabled={checking === d.id}
                              >
                                <RefreshCw className={cn(checking === d.id && "animate-spin")} /> Check now
                              </Button>
                            </div>
                            <CheckResult domain={d} />
                            {d.lastCheck?.error && !d.verified && (
                              <p className="text-sm text-destructive">{d.lastCheck.error}</p>
                            )}
                          </div>
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

      <AddDomainDialog
        open={adding}
        onOpenChange={setAdding}
        publicAddress={props.publicAddress}
        onAdded={props.onChanged}
        onOpenSettings={() => {
          setAdding(false);
          props.onOpenSettings();
        }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You won't be able to create new services on it. Domains still used by services can't be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && remove(deleting)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
