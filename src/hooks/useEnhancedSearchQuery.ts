import { useCallback, useEffect, useRef, useState } from "react";
import { perf } from "../lib/perfTrace";
import { searchApi } from "../platform/searchApi";
import type { BuiltinSearchHit } from "../types";

export interface EnhancedFileResult {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  iconKey: string;
  icon?: string | null;
}

export interface EnhancedSearchQueryOptions {
  open: boolean;
  query: string;
  engine: "builtin" | "everything";
  itemsRevision: number;
  builtinLimit: number;
  everythingLimit: number;
  builtinDebounceMs: number;
  everythingDebounceMs: number;
}

export function useEnhancedSearchQuery({
  open,
  query,
  engine,
  itemsRevision,
  builtinLimit,
  everythingLimit,
  builtinDebounceMs,
  everythingDebounceMs,
}: EnhancedSearchQueryOptions) {
  const [fileResults, setFileResults] = useState<EnhancedFileResult[]>([]);
  const [builtinHits, setBuiltinHits] = useState<BuiltinSearchHit[]>([]);
  const requestRef = useRef(0);

  const clearResults = useCallback(() => {
    requestRef.current++;
    setFileResults([]);
    setBuiltinHits([]);
  }, []);

  useEffect(() => {
    if (!open) { clearResults(); return; }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) { clearResults(); return; }

    // Query changes invalidate in-flight work immediately; waiting until debounce fires lets stale results win.
    const token = ++requestRef.current;
    const useEverything = engine === "everything";
    const limit = useEverything ? everythingLimit : builtinLimit;
    const timer = setTimeout(async () => {
      try {
        if (useEverything) {
          const t0 = performance.now();
          const response = await searchApi.searchEverything(normalizedQuery, limit);
          perf.record("ipc:everything", performance.now() - t0);
          if (token !== requestRef.current) return;
          setBuiltinHits([]);
          setFileResults(response.results.map(result => ({ ...result, icon: response.icons[result.iconKey] ?? null })));
          perf.mark("results"); // 响应落状态 → 高亮 effect 里的 results→paint 段以此为 t0
        } else {
          const t0 = performance.now();
          const response = await searchApi.searchBuiltin(normalizedQuery, limit);
          perf.record("ipc:builtin", performance.now() - t0);
          if (token !== requestRef.current) return;
          setFileResults([]);
          setBuiltinHits(response.results.map(hit => hit.kind === "fs" ? { ...hit, icon: response.icons[hit.iconKey] ?? null } : hit));
          perf.mark("results");
        }
      } catch {
        if (token !== requestRef.current) return;
        if (useEverything) setFileResults([]);
        else setBuiltinHits([]);
      }
    }, useEverything ? everythingDebounceMs : builtinDebounceMs);

    return () => clearTimeout(timer);
  }, [
    open,
    query,
    engine,
    itemsRevision,
    builtinLimit,
    everythingLimit,
    builtinDebounceMs,
    everythingDebounceMs,
    clearResults,
  ]);

  return { fileResults, builtinHits, clearResults };
}
