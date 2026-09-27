import { Laptop, Monitor, Server, Smartphone, type LucideProps } from "lucide-react";

export function OsIcon({ os, ...props }: { os: string } & LucideProps) {
  const o = os.toLowerCase();
  if (o === "linux" || o.includes("freebsd")) return <Server {...props} />;
  if (o === "ios" || o === "android") return <Smartphone {...props} />;
  if (o === "macos") return <Laptop {...props} />;
  return <Monitor {...props} />;
}
