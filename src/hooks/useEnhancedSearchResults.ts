import { useMemo } from "react";
import {
  buildEnhancedSearchResultModel,
  type BuildEnhancedSearchResultModelOptions,
} from "../domain/enhancedSearchResults";

export type EnhancedSearchResultsOptions = Omit<BuildEnhancedSearchResultModelOptions, "nowSeconds">;

export function useEnhancedSearchResults(options: EnhancedSearchResultsOptions) {
  return useMemo(() => buildEnhancedSearchResultModel({
    ...options,
    nowSeconds: Math.floor(Date.now() / 1000),
  }), [
    options.engine,
    options.query,
    options.apps,
    options.sortedApps,
    options.stage,
    options.clipboard,
    options.appUsage,
    options.pinyin,
    options.builtinHits,
    options.fileResults,
    options.everythingFileLimit,
    options.minFileSection,
    options.t,
  ]);
}
