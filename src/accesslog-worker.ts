// Computes the Requests page's stats and request count, and the Services list's traffic, off the server's thread, on
// its own read-only connection.
import { Database } from "bun:sqlite";
import { countEntries, serviceTraffic, stats } from "./accesslog-query";
import type { WorkerJob } from "./accesslog";

declare const self: Worker;

let db: Database | null = null;

self.onmessage = (e: MessageEvent<{ id: number; dbPath: string; job: WorkerJob }>) => {
  const { id, dbPath, job } = e.data;
  try {
    db ??= new Database(dbPath, { readonly: true, strict: true });
    const result =
      job.kind === "stats"
        ? stats(db, job.filters)
        : job.kind === "count"
          ? countEntries(db, job.filters, job.upTo)
          : serviceTraffic(db);
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: (err as Error).message });
  }
};
