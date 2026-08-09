import type { BuiltinSearchHit } from "../types";

export interface SearchFileHit {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  iconKey: string;
}

export interface SearchResponse<T> {
  results: T[];
  icons: Record<string, string>;
}

export type SearchInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export function createSearchApi(invoke: SearchInvoke) {
  return {
    searchEverything: (query: string, limit: number) =>
      invoke<SearchResponse<SearchFileHit>>("search_files", { query, limit }),
    searchBuiltin: (query: string, limit: number) =>
      invoke<SearchResponse<BuiltinSearchHit>>("search_builtin_all", { query, limit }),
  };
}

const invokeSearch: SearchInvoke = async <T>(command: string, args: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

export const searchApi = createSearchApi(invokeSearch);
