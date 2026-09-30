// Computes the Requests page's stats and the Services list's traffic off the server's thread, on its own read-only
// connection.
import { Database } from "bun:sqlite";
import { serviceTraffic, stats } from "./accesslog-query";
import type { WorkerJob } from "./accesslog";

declare const self: Worker;

let db: Database | null = null;

self.onmessage = (e: MessageEvent<{ id: number; dbPath: string; job: WorkerJob }>) => {
  const { id, dbPath, job } = e.data;
  try {
    db ??= new Database(dbPath, { readonly: true, strict: true });
    postMessage({ id, result: job.kind === "stats" ? stats(db, job.filters) : serviceTraffic(db) });
  } catch (err) {
    postMessage({ id, error: (err as Error).message });
  }
};
