// Enhanced search result-model tests. Exercise the real pure pipeline used by rows,
// preview, Enter and cross-section keyboard navigation.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "enhanced-search-results-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/domain/enhancedSearchResults.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const { buildEnhancedSearchResultModel } = await import(pathToFileURL(outfile).href);
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};
const t = (key, vars) => vars ? key.replace("{n}", String(vars.n)) : key;
const app = (name, path) => ({ name, path, icon: null });
const file = (path, ext, isDir = false) => ({
  path,
  name: path.split("/").at(-1),
  ext,
  isDir,
  iconKey: `${isDir ? "dir" : ext}:${path}`,
});
const base = overrides => ({
  engine: "builtin",
  query: "report",
  apps: [],
  sortedApps: [],
  stage: [],
  clipboard: [],
  appUsage: {},
  pinyin: {},
  builtinHits: [],
  fileResults: [],
  nowSeconds: 1_000,
  everythingFileLimit: 500,
  minFileSection: 3,
  t,
  ...overrides,
});

console.log("\n增强搜索结果模型 —— 内置引擎权威排名");

const reportApp = app("Report Studio", "C:/report.exe");
const reportStage = {
  id: 7,
  type: "file",
  name: "Report Draft",
  items: [{ path: "D:/report.docx", name: "report.docx", ext: "docx", isImage: false }],
};
const reportClip = { type: "text", time: 9, content: "Report notes" };
const builtin = buildEnhancedSearchResultModel(base({
  apps: [reportApp],
  sortedApps: [reportApp],
  stage: [reportStage],
  clipboard: [reportClip],
  builtinHits: [
    { kind: "fs", ...file("D:/best.pdf", "pdf") },
    { kind: "app", key: reportApp.path },
    { kind: "fs", ...file("D:/second.docx", "docx") },
    { kind: "stage", key: "missing" },
    { kind: "stage", key: String(reportStage.id) },
    { kind: "clip", key: String(reportClip.time) },
  ],
}));

check("Rust 第一名分段后仍是扁平第一项", builtin.results[0]?.kind === "fs" && builtin.results[0].path === "D:/best.pdf");
check(
  "同类结果保持 Rust 内部顺序",
  builtin.results[1]?.kind === "fs" && builtin.results[1].path === "D:/second.docx",
);
check("动态来源的失效 key 被跳过", builtin.results.length === 5, `实际 ${builtin.results.length}`);
check(
  "段序由该类首次全局名次决定",
  builtin.sections.map(section => section.key).join(",") === "builtin-fs-doc,builtin-t1-app,builtin-t1-stage,builtin-t1-clip",
  builtin.sections.map(section => section.key).join(","),
);
check("段首下标从同一 sections 派生", builtin.sectionStarts.join(",") === "0,2,3,4");
check("段标题含稳定计数", builtin.headingByIndex.get(0) === "文档 (2)" && builtin.headingByIndex.get(4) === "剪贴板 (1)");
check("投影结果重新计算名称高亮", builtin.results[2]?.kind === "app" && builtin.results[2].ranges.length > 0);

console.log("\n增强搜索结果模型 —— Everything 兼容管线");

const lessUsed = app("Report Alpha", "C:/alpha.exe");
const moreUsed = app("Report Beta", "C:/beta.exe");
const everything = buildEnhancedSearchResultModel(base({
  engine: "everything",
  apps: [lessUsed, moreUsed],
  sortedApps: [lessUsed, moreUsed],
  appUsage: {
    [lessUsed.path]: { count: 1, last_used: 1_000 },
    [moreUsed.path]: { count: 10, last_used: 1_000 },
  },
  stage: [reportStage, { id: 8, type: "text", content: "report text must not enter Tier1" }],
  clipboard: [reportClip],
  fileResults: [
    file("E:/report.pdf", "pdf"),
    file("E:/report.docx", "docx"),
    file("E:/cover.png", "png"),
  ],
  minFileSection: 2,
}));

check("同分应用按使用分排序", everything.results[0]?.kind === "app" && everything.results[0].app.path === moreUsed.path);
check("非 file 中转条目不进入结果", !everything.results.some(result => result.kind === "stage" && result.item.id === 8));
check(
  "Tier1 与文件段保持既有来源顺序",
  everything.sections.map(section => section.key).join(",") === "t1-app,t1-stage,t1-clip,fs-doc,fs-other",
  everything.sections.map(section => section.key).join(","),
);
check("零散文件类别并入 other 且不丢结果", everything.results.filter(result => result.kind === "fs").length === 3);
check("导航末段下标与扁平结果一致", everything.sectionStarts.at(-1) === everything.results.length - 1);

const clipTypeFallback = buildEnhancedSearchResultModel(base({
  engine: "everything",
  query: "png",
  clipboard: [{ type: "image", time: 10 }],
}));
check("剪贴板类型词仍能兜底命中", clipTypeFallback.results[0]?.kind === "clip");

const fallbackApps = Array.from({ length: 35 }, (_, index) => app(`App ${index}`, `C:/${index}.exe`));
const empty = buildEnhancedSearchResultModel(base({
  query: "",
  apps: fallbackApps,
  sortedApps: fallbackApps,
}));
check("空查询只取前 30 个常用应用", empty.results.length === 30 && empty.sections.length === 1);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
