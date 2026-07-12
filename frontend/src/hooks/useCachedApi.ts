import { useCallback, useEffect, useRef, useState } from "react";
import { postCacheRefresh } from "../api/client";
import type { CacheMeta } from "../types";

interface CachedApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  cache: CacheMeta | null;
  refresh: () => void;
}

const POLL_MS = 8000;
const MAX_POLLS = 60; // give a slow refresh up to ~8 minutes

// useApi + cache awareness: exposes the envelope's cache meta, and while the
// served object is refreshing in the background, silently re-polls so the
// fresh data (and cleared "refreshing" state) lands without a manual reload.
// refresh() kicks the object's background rebuild explicitly.
export function useCachedApi<T extends { cache?: CacheMeta }>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): CachedApiState<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const [pollTick, setPollTick] = useState(0);
  const polls = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Background polls must not blank the page — keep existing data visible.
    setState((s) => ({ ...s, loading: s.data == null, error: null }));
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState((s) => ({ data: s.data, loading: false, error: err instanceof Error ? err.message : String(err) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pollTick]);

  // While the very first response is still in flight there is no cached copy
  // to describe — surface a truthful "building" meta so the page's freshness
  // badge shows a refreshing state instead of disappearing entirely.
  const BUILDING: CacheMeta = {
    object: "",
    computed_at: null,
    age_seconds: null,
    ttl_seconds: 0,
    refreshing: true,
    error: null,
  };
  const cache = state.data?.cache ?? (state.loading ? BUILDING : null);

  // While the object is refreshing, poll until it settles (bounded). Only
  // once data has landed — the synthetic "building" meta must not restart
  // the in-flight first fetch.
  useEffect(() => {
    if (state.data == null) return;
    if (!cache?.refreshing) {
      polls.current = 0;
      return;
    }
    if (polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      setPollTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [cache?.refreshing, pollTick, state.data]);

  const refresh = useCallback(() => {
    const objectId = state.data?.cache?.object;
    if (!objectId) return;
    postCacheRefresh(objectId)
      .catch(() => undefined)
      .finally(() => {
        polls.current = 0;
        setPollTick((n) => n + 1); // re-fetch → picks up refreshing=true → keeps polling
      });
  }, [state.data?.cache?.object]);

  return { ...state, cache, refresh };
}
