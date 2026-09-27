import { useCallback, useEffect, useState } from "react";

/** Loads `fn` on mount and every `intervalMs` (0 = only on mount / manual reload). */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fn]);
  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const t = setInterval(reload, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);
  return { data, error, reload, setData, loading: data === null && error === null };
}
