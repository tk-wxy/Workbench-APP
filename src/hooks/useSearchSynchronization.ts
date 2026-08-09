import { useEffect, useRef, useState } from "react";
import {
  buildSearchProjection,
  collectPinyinNames,
  mergePinyinBatch,
  prunePinyinTable,
} from "../domain/searchSynchronization";
import type { SearchTranslate } from "../domain/enhancedSearchResults";
import type { PinyinTable } from "../lib/pinyin";
import { searchSynchronizationApi } from "../platform/searchSynchronizationApi";
import type { AppInfo, AppUsage, ClipItem, StageItem } from "../types";

export function useSearchSynchronization(options: {
  apps: AppInfo[];
  stage: StageItem[];
  clipboard: ClipItem[];
  appUsage: Record<string, AppUsage>;
  t: SearchTranslate;
  enhancedOpen: boolean;
  settingsOpen: boolean;
  searchEngine: "builtin" | "everything";
}) {
  const [pinyin, setPinyin] = useState<PinyinTable>({});
  const [itemsRevision, setItemsRevision] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const [everythingAvailable, setEverythingAvailable] = useState(false);
  const requestedPinyinRef = useRef<Set<string>>(new Set());
  const itemsSyncRevisionRef = useRef(Date.now());

  useEffect(() => {
    const all = collectPinyinNames(options.apps, options.stage, options.clipboard, options.t);
    requestedPinyinRef.current = new Set([...all].filter(name => requestedPinyinRef.current.has(name)));
    setPinyin(previous => prunePinyinTable(previous, all));
    const wanted = [...all].filter(name => !requestedPinyinRef.current.has(name));
    if (!wanted.length) return;
    for (const name of wanted) requestedPinyinRef.current.add(name);
    searchSynchronizationApi.derivePinyin(wanted)
      .then(variants => setPinyin(previous => mergePinyinBatch(previous, wanted, variants)))
      .catch(error => {
        console.warn("[pinyin] 派生失败，本批退回直接匹配：", error);
        for (const name of wanted) requestedPinyinRef.current.delete(name);
      });
  }, [options.apps, options.stage, options.clipboard, options.t]);

  useEffect(() => {
    const revision = ++itemsSyncRevisionRef.current;
    const items = buildSearchProjection({
      apps: options.apps,
      stage: options.stage,
      clipboard: options.clipboard,
      appUsage: options.appUsage,
      nowSeconds: Math.floor(Date.now() / 1000),
      t: options.t,
    });
    searchSynchronizationApi.setItems(revision, items)
      .then(applied => {
        if (revision === itemsSyncRevisionRef.current) setItemsRevision(applied);
      })
      .catch(error => console.warn("[search] 动态搜索投影同步失败：", error));
  }, [options.apps, options.stage, options.clipboard, options.appUsage, options.t]);

  useEffect(() => {
    if (!options.enhancedOpen && !options.settingsOpen) return;
    searchSynchronizationApi.getStatus()
      .then(status => {
        setIndexReady(status.ready);
        setEverythingAvailable(!!status.everythingAvailable);
      })
      .catch(() => {});
  }, [options.enhancedOpen, options.settingsOpen, options.searchEngine]);

  return {
    pinyin,
    itemsRevision,
    indexReady,
    setIndexReady,
    everythingAvailable,
    setEverythingAvailable,
  };
}
