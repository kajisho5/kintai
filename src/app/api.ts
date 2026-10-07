import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    signal: init.signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | undefined)?.error ?? `通信に失敗しました（${res.status}）`;
    if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("kintai:unauthorized"));
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

export interface ApiState<T> {
  data?: T;
  error?: string;
  /** 取得中（前回のデータが残っている間は data も入っている） */
  loading: boolean;
  reload: () => void;
}

/** GET の取得。path が変わると再取得し、取得中も前回のデータを保持する */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: path !== null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (path === null) return;
    const ac = new AbortController();
    setState((s) => ({ data: s.data, loading: true }));
    api<T>(path, { signal: ac.signal })
      .then((data) => setState({ data, loading: false }))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : "通信に失敗しました", loading: false }));
      });
    return () => ac.abort();
  }, [path, tick]);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(() => setTick((n) => n + 1), opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs]);

  return { ...state, reload };
}
