import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status";
import { api, type CaptchaView, type ProxyHost } from "@/lib/api";

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

export function CaptchaPage(props: {
  view: CaptchaView | null;
  error: string | null;
  hosts: ProxyHost[];
  onChanged: (view: CaptchaView) => void;
  onOpenService: (id: number) => void;
}) {
  const { view } = props;
  const [siteKey, setSiteKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [lifetime, setLifetime] = useState(86_400);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const hostById = new Map(props.hosts.map((h) => [h.id, h]));

  // The form starts from the saved widget, and again after every save.
  const siteKeySaved = view?.siteKey;
  const lifetimeSaved = view?.lifetime;
  useEffect(() => {
    if (siteKeySaved === undefined || lifetimeSaved === undefined) return;
    setSiteKey(siteKeySaved);
    setLifetime(lifetimeSaved);
    setSecretKey("");
  }, [siteKeySaved, lifetimeSaved]);

  if (!view)
    return (
      <>
        <PageHeader title="Captcha" description="A Cloudflare Turnstile challenge in front of your services." />
        {props.error ? (
          <p className="text-sm text-destructive">{props.error}</p>
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </>
    );

  const dirty = siteKey !== view.siteKey || lifetime !== view.lifetime || !!secretKey;
  const canSave = dirty && !!siteKey && (view.configured || !!secretKey);
  const lifetimes = LIFETIMES.some(([s]) => s === lifetime) ? LIFETIMES : [...LIFETIMES, [lifetime, lifetimeLabel(lifetime)] as const];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      props.onChanged(await api.saveCaptcha({ siteKey, secretKey: secretKey || undefined, lifetime }));
      setSecretKey("");
      toast.success("Captcha saved", { description: "Traefik picks it up within about 5 seconds." });
    } catch (e) {
      toast.error("Couldn't save the captcha", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      props.onChanged(await api.removeCaptcha());
      toast.success("Captcha removed");
    } catch (e) {
      toast.error("Couldn't remove the captcha", { description: (e as Error).message });
    }
  };

  return (
    <form onSubmit={save}>
      <PageHeader
        title="Captcha"
        description="A Cloudflare Turnstile challenge visitors solve before reaching a service. Set up the widget here, then turn it on for each service in its Authentication tab."
      >
        {view.configured ? (
          <ToneBadge t="success">
            <span className="size-1.5 rounded-full bg-current" /> Set up
          </ToneBadge>
        ) : (
          <ToneBadge t="muted">Not set up</ToneBadge>
        )}
        <Button type="submit" disabled={busy || !canSave}>
          {busy && <Loader2 className="animate-spin" />} Save
        </Button>
      </PageHeader>

      <div className="grid max-w-3xl gap-6">
        <div className="grid gap-2">
          <Label htmlFor="captcha-site-key">Site key</Label>
          <Input
            id="captcha-site-key"
            value={siteKey}
            onChange={(e) => setSiteKey(e.target.value.trim())}
            placeholder="0x4AAAAAAA…"
            autoComplete="off"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Create a widget in the{" "}
            <a href={DASHBOARD} target="_blank" rel="noreferrer" className="underline">
              Cloudflare Turnstile dashboard
            </a>{" "}
            and allow the hostnames of the services that use it, including parallel aliases.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="captcha-secret-key">{view.configured ? "New secret key" : "Secret key"}</Label>
          <Input
            id="captcha-secret-key"
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value.trim())}
            placeholder={view.configured ? "Leave empty to keep the current one" : "0x4AAAAAAA…"}
            autoComplete="off"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">Checked with Cloudflare when you save. It can't be shown again.</p>
        </div>

        <div className="grid gap-2">
          <Label>Remember visitors for</Label>
          <Select value={String(lifetime)} onValueChange={(v) => setLifetime(Number(v))}>
            <SelectTrigger className="w-48">
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

        <Separator />

        <div className="grid gap-2">
          <Label>Services that ask for it</Label>
          {view.hostIds.length ? (
            <div className="flex flex-wrap gap-1.5">
              {view.hostIds.map((id) => (
                <Button key={id} type="button" size="xs" variant="outline" onClick={() => props.onOpenService(id)}>
                  {hostById.get(id)?.domains[0] ?? `Service ${id}`}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              None yet. Turn on <strong>Captcha</strong> in a service's Authentication tab.
            </p>
          )}
        </div>

        {view.configured && (
          <>
            <Separator />
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label>Remove the widget</Label>
                <p className="text-xs text-muted-foreground">
                  {view.hostIds.length
                    ? "Turn the captcha off for every service first."
                    : "Deletes the keys from proxytail. The widget stays in your Cloudflare account."}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                disabled={view.hostIds.length > 0}
                onClick={() => setRemoving(true)}
              >
                <Trash2 /> Remove
              </Button>
            </div>
          </>
        )}
      </div>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the captcha?</AlertDialogTitle>
            <AlertDialogDescription>
              proxytail forgets the site key and secret key. You can set it up again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={remove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
