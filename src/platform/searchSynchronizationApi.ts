import type { PinyinVariant } from "../lib/pinyin";
import type { SearchProjectionItem } from "../domain/searchSynchronization";

export type SearchSynchronizationInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type SearchIndexStatus = {
  ready: boolean;
  count: number;
  everythingAvailable: boolean;
};

export function createSearchSynchronizationApi(invoke: SearchSynchronizationInvoke) {
  return {
    derivePinyin: (names: string[]) => invoke<PinyinVariant[][]>("to_pinyin_batch", { names }),
    setItems: (revision: number, items: SearchProjectionItem[]) =>
      invoke<number>("set_search_items", { revision, items }),
    getStatus: () => invoke<SearchIndexStatus>("get_index_status"),
  };
}

const invokeNative: SearchSynchronizationInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

export const searchSynchronizationApi = createSearchSynchronizationApi(invokeNative);
