// Computes the Requests page's stats off the server's thread, on its own read-only connection.
import { Database } from "bun:sqlite";
import { stats, type Filters } from "./accesslog-query";

declare const self: Worker;

let db: Database | null = null;

self.onmessage = (e: MessageEvent<{ id: number; dbPath: string; filters: Filters }>) => {
  const { id, dbPath, filters } = e.data;
  try {
    db ??= new Database(dbPath, { readonly: true, strict: true });
    postMessage({ id, result: stats(db, filters) });
  } catch (err) {
    postMessage({ id, error: (err as Error).message });
  }
};
