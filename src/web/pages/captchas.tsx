import { useEffect, useState, type FormEvent } from "react";
import { BotOff, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { PageHeader } from "@/components/page-header";
import { api, type Captcha, type ProxyHost } from "@/lib/api";

const DASHBOARD = "https://dash.cloudflare.com/?to=/:account/turnstile";

/** How long a visitor who solved the captcha is let through, in seconds. */
const LIFETIMES: [number, string][] = [
  [30 * 60, "30 minutes"],
  [3600, "1 hour"],
  [12 * 3600, "12 hours"],
  [86_400, "1 day"],
  [7 * 86_400, "7 days"],
  [30 * 86_400, "30 days"],
];

export function lifetimeLabel(seconds: number) {
  const preset = LIFETIMES.find(([s]) => s === seconds);
  if (preset) return preset[1];
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** Adds a captcha (`captcha` null) or changes one. */
function CaptchaDialog(props: {
  open: boolean;
  captcha: Captcha | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { captcha } = props;
  const [name, setName] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [lifetime, setLifetime] = useState(86_400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(captcha?.name ?? "");
    setSiteKey(captcha?.siteKey ?? "");
    setSecretKey("");
    setLifetime(captcha?.lifetime ?? 86_400);
    setError(null);
  }, [props.open, captcha]);

  const needsSecret = !captcha;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const draft = { name, siteKey, secretKey: secretKey || undefined, lifetime };
      const saved = captcha ? await api.updateCaptcha(captcha.id, draft) : await api.createCaptcha(draft);
      toast.success(captcha ? `Saved ${saved.name}` : `Added ${saved.name}`);
      props.onSaved();
      props.onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lifetimes = LIFETIMES.some(([s]) => s === lifetime) ? LIFETIMES : [...LIFETIMES, [lifetime, lifetimeLabel(lifetime)] as const];

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <BotOff className="size-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>{captcha ? `Edit ${captcha.name}` : "Add captcha"}</DialogTitle>
              <DialogDescription>
                {captcha ? "Changes apply to every service that asks for it." : "Then pick it in a service's Authentication tab."}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-4 px-6 pb-5">
            <div className="grid gap-2">
              <Label htmlFor="captcha-name">Name</Label>
              <Input
                id="captcha-name"
                autoFocus={!captcha}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Public sites"
                maxLength={64}
                autoComplete="off"
                className="h-10"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="captcha-site-key">Site key</Label>
              <Input
                id="captcha-site-key"
                value={siteKey}
                onChange={(e) => setSiteKey(e.target.value.trim())}
                placeholder="0x4AAAAAAA…"
                autoComplete="off"
                className="h-10 font-mono"
                required
              />
              <p className="text-xs text-muted-foreground">
                Create a widget in the{" "}
                <a href={DASHBOARD} target="_blank" rel="noreferrer" className="underline">
                  Cloudflare Turnstile dashboard
                </a>{" "}
                and allow the hostnames of the services you'll attach it to.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="captcha-secret-key">{needsSecret ? "Secret key" : "New secret key"}</Label>
              <Input
                id="captcha-secret-key"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value.trim())}
                placeholder={needsSecret ? "0x…" : "Leave empty to keep the current one"}
                autoComplete="off"
                className="h-10 font-mono"
                required={needsSecret}
              />
              <p className="text-xs text-muted-foreground">
                Checked with Cloudflare when you save. It can't be shown again.
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Remember visitors for</Label>
              <Select value={String(lifetime)} onValueChange={(v) => setLifetime(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lifetimes.map(([s, label]) => (
                    <SelectItem key={s} value={String(s)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                After solving it, a visitor isn't asked again on that hostname for this long.
              </p>
            </div>
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
            <Button type="submit" disabled={busy || !name.trim() || !siteKey || (needsSecret && !secretKey)}>
              {busy && <Loader2 className="animate-spin" />} {captcha ? "Save" : "Add captcha"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CaptchasPage(props: {
  captchas: Captcha[] | null;
  hosts: ProxyHost[];
  onChanged: () => void;
  onOpenService: (id: number) => void;
}) {
  // `undefined`: closed; `null`: adding a captcha.
  const [editing, setEditing] = useState<Captcha | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Captcha | null>(null);
  const hostById = new Map(props.hosts.map((h) => [h.id, h]));

  const remove = async (c: Captcha) => {
    try {
      await api.deleteCaptcha(c.id);
      toast.success(`Deleted ${c.name}`);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Captchas"
        description="Cloudflare Turnstile widgets that visitors solve before reaching a service. Attach one to any number of services."
      >
        <Button onClick={() => setEditing(null)}>
          <Plus /> Add captcha
        </Button>
      </PageHeader>

      <Card className="gap-0 py-0">
        {props.captchas === null ? (
          <div className="space-y-3 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : props.captchas.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
              <BotOff className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No captchas yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Add the site key and secret key of a Cloudflare Turnstile widget, then pick it for a service to keep bots
                out.
              </p>
            </div>
            <Button onClick={() => setEditing(null)} className="mt-2">
              <Plus /> Add captcha
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Captcha</TableHead>
                <TableHead>Remembers visitors</TableHead>
                <TableHead>Services</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.captchas.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="py-3 pl-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-primary/10 text-primary">
                        <BotOff className="size-4" />
                      </div>
                      <div className="min-w-0 leading-tight">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={c.siteKey}>
                          {c.siteKey}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{lifetimeLabel(c.lifetime)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {c.hostIds.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {c.hostIds.map((id) => (
                          <Button key={id} size="xs" variant="outline" onClick={() => props.onOpenService(id)}>
                            {hostById.get(id)?.domains[0] ?? `Service ${id}`}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setEditing(c)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CaptchaDialog
        open={editing !== undefined}
        captcha={editing ?? null}
        onOpenChange={(o) => !o && setEditing(undefined)}
        onSaved={props.onChanged}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Captchas that a service still asks for can't be deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && remove(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
