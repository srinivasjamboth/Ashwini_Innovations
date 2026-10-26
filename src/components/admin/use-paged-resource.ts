"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The shared paging effect (spec Part 1B): fetch a page whenever its URL
 * changes, but never let a slow earlier response clobber a fast later one
 * (rapid pager clicks — the LAST click wins). On success we bump a
 * `version` so the caller can re-key the table and replay the ~150 ms
 * fade-in. On failure we keep the previous rows on screen (`data` is not
 * cleared) and surface `error` so the caller shows a Retry.
 */
export function usePagedResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const [nonce, setNonce] = useState(0);
  // Monotonic sequence — only the newest request may write state.
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let ignore = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`paged fetch ${res.status}`);
        const json = (await res.json()) as T;
        if (ignore || seq !== seqRef.current) return; // out-of-order ⇒ drop
        setData(json);
        setError(false);
        setVersion((v) => v + 1);
      } catch {
        if (ignore || seq !== seqRef.current) return;
        setError(true); // keep the old rows already in `data`
      } finally {
        if (!ignore && seq === seqRef.current) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [url, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, retry, version };
}
