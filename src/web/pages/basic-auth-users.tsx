import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { api, type BasicAuthUser, type ProxyHost } from "@/lib/api";
import { timeAgo } from "@/lib/utils";

const MIN_PASSWORD = 8;

/** SQLite's datetime('now') is UTC without a zone. */
const parseUtc = (s: string) => new Date(`${s.replace(" ", "T")}Z`).toISOString();

/** Adds a user (`user` null) or changes one's username and/or password. */
function UserDialog(props: {
  open: boolean;
  user: BasicAuthUser | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (user: BasicAuthUser) => void;
}) {
  const { user } = props;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setUsername(user?.username ?? "");
    setPassword("");
    setError(null);
  }, [props.open, user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = user
        ? await api.updateBasicAuthUser(user.id, { username, password: password || undefined })
        : await api.createBasicAuthUser({ username, password });
      toast.success(user ? `Saved ${saved.username}` : `Added ${saved.username}`);
      props.onSaved(saved);
      props.onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shared = (user?.hostIds.length ?? 0) > 1;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader className="flex-row items-center gap-4 space-y-0 px-6 pt-6 pb-4 text-left">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <KeyRound className="size-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>{user ? `Edit ${user.username}` : "Add user"}</DialogTitle>
              <DialogDescription>
                {user ? "Changes apply to every service they can sign in to." : "Then pick them in a service's Authentication tab."}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-4 px-6 pb-5">
            <div className="grid gap-2">
              <Label htmlFor="user-name">Username</Label>
              <Input
                id="user-name"
                autoFocus={!user}
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/[\s:]/g, ""))}
                placeholder="alice"
                maxLength={64}
                autoComplete="off"
                className="h-10 font-mono"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="user-password">{user ? "New password" : "Password"}</Label>
              <Input
                id="user-password"
                type="password"
                autoFocus={!!user}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={user ? "Leave empty to keep the current one" : `At least ${MIN_PASSWORD} characters`}
                autoComplete="new-password"
                className="h-10 font-mono"
                required={!user}
              />
              <p className={tooShort ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {tooShort
                  ? `At least ${MIN_PASSWORD} characters.`
                  : shared && password
                    ? `The new password applies to all ${user!.hostIds.length} services.`
                    : "Stored as a bcrypt hash; it can't be shown again."}
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
            <Button
              type="submit"
              disabled={busy || !username.trim() || tooShort || (!user && !password) || (!!user && username === user.username && !password)}
            >
              {busy && <Loader2 className="animate-spin" />} {user ? "Save" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BasicAuthUsersPage(props: {
  users: BasicAuthUser[] | null;
  hosts: ProxyHost[];
  onChanged: () => void;
  onOpenService: (id: number) => void;
}) {
  // `undefined`: closed; `null`: adding a user.
  const [editing, setEditing] = useState<BasicAuthUser | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<BasicAuthUser | null>(null);
  const hostById = new Map(props.hosts.map((h) => [h.id, h]));

  const remove = async (user: BasicAuthUser) => {
    try {
      await api.deleteBasicAuthUser(user.id);
      toast.success(`Deleted ${user.username}`);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Basic auth users"
        description="Usernames and passwords for services behind basic auth. Attach a user to any number of services."
      >
        <Button onClick={() => setEditing(null)}>
          <Plus /> Add user
        </Button>
      </PageHeader>

      <Card className="gap-0 py-0">
        {props.users === null ? (
          <div className="space-y-3 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : props.users.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
              <KeyRound className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No users yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Add a user, then turn on basic auth for a service and pick who can sign in.
              </p>
            </div>
            <Button onClick={() => setEditing(null)} className="mt-2">
              <Plus /> Add user
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">User</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>Last changed</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="py-3 pl-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-primary/10 text-primary">
                        <KeyRound className="size-4" />
                      </div>
                      <span className="truncate font-mono text-sm font-medium">{u.username}</span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {u.hostIds.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {u.hostIds.map((id) => (
                          <Button key={id} size="xs" variant="outline" onClick={() => props.onOpenService(id)}>
                            {hostById.get(id)?.domains[0] ?? `Service ${id}`}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={new Date(parseUtc(u.updatedAt)).toLocaleString()}>
                    {timeAgo(parseUtc(u.updatedAt))}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setEditing(u)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(u)}>
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

      <UserDialog
        open={editing !== undefined}
        user={editing ?? null}
        onOpenChange={(o) => !o && setEditing(undefined)}
        onSaved={props.onChanged}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.username}?</AlertDialogTitle>
            <AlertDialogDescription>Users who can still sign in to a service can't be deleted.</AlertDialogDescription>
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
