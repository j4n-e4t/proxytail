// Entry point. `proxytail healthcheck` probes the running server (used by Docker, which has no curl in the image).
if (process.argv.includes("healthcheck")) {
  const port = process.env.PORT ?? "3000";
  const ok = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  process.exit(ok ? 0 : 1);
}

await import("./server");
