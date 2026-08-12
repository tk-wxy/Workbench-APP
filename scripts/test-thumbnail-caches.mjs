// Thumbnail cache controller regression tests. Bundle the real TypeScript module so the
// key-space and pruning rules exercised here are exactly the rules used by the hook.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "thumbnail-caches-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/hooks/useThumbnailCaches.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});

const {
  collectClipThumbnailTimes,
  collectStageThumbnailKeys,
  pruneNumberThumbnailCache,
  pruneStringThumbnailCache,
  stageImageThumbKey,
} = await import(pathToFileURL(outfile).href);

let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
};
const sameJson = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

console.log("\n缩略图缓存 —— 键空间、去重与淘汰");

const stageKeys = collectStageThumbnailKeys([
  { id: 1, type: "file", items: [{ path: "C:/shared.png", name: "shared.png", ext: "png", isImage: true }] },
  { id: 2, type: "file", items: [{ path: "C:/notes.txt", name: "notes.txt", ext: "txt", isImage: false }] },
  { id: 3, type: "image", contentFile: "stage-3.png" },
  { id: 4, type: "text", content: "not an image" },
], [
  { id: 5, kind: "file", name: "shared.png", path: "C:/shared.png", ext: "PNG" },
  { id: 6, kind: "file", name: "photo.jpg", path: "D:/photo.jpg", ext: "JPG" },
  { id: 7, kind: "folder", name: "folder", path: "D:/folder", ext: "png" },
  { id: 8, kind: "file", name: "legacy.png", path: "D:/legacy.png" },
  { id: 9, kind: "file", name: "dotted.png", path: "D:/dotted.png", ext: ".PNG" },
  { id: 10, kind: "file", name: "vector.svg", path: "D:/vector.svg", ext: "svg" },
]);
check("中转文件、启动台图片和外置 image 共用一个去重键集",
  sameJson(stageKeys, ["C:/shared.png", "D:/photo.jpg", "D:/legacy.png", "D:/dotted.png", "simg:stage-3.png"]),
  JSON.stringify(stageKeys));
check("旧启动台项缺少 ext 或导入项带点扩展名仍进入缩略图队列", stageKeys.includes("D:/legacy.png") && stageKeys.includes("D:/dotted.png"));
check("原生解码器不支持的 SVG 不会反复请求失败缩略图", !stageKeys.includes("D:/vector.svg"));
check("外置中转图片键使用独立前缀", stageImageThumbKey("abc.png") === "simg:abc.png");

const clipTimes = collectClipThumbnailTimes([
  { type: "image", time: 11 },
  { type: "text", time: 12, content: "text" },
  { type: "image", time: 11 },
  { type: "image", time: 13 },
]);
check("剪贴板仅收集图片 time 并去重", sameJson(clipTimes, [11, 13]), JSON.stringify(clipTimes));

const stringCache = { keep: "thumb-a", stale: "thumb-b" };
const prunedString = pruneStringThumbnailCache(stringCache, new Set(["keep"]));
check("字符串缓存删除非存活键", sameJson(prunedString, { keep: "thumb-a" }), JSON.stringify(prunedString));
check("字符串缓存发生淘汰时返回新引用", prunedString !== stringCache);
check("字符串缓存无淘汰时保持原引用",
  pruneStringThumbnailCache(prunedString, new Set(["keep"])) === prunedString);

const numberCache = { 11: "thumb-11", 13: "thumb-13" };
const prunedNumber = pruneNumberThumbnailCache(numberCache, new Set([13]));
check("数字缓存按 number time 淘汰", sameJson(prunedNumber, { 13: "thumb-13" }), JSON.stringify(prunedNumber));
check("数字缓存无淘汰时保持原引用",
  pruneNumberThumbnailCache(prunedNumber, new Set([13])) === prunedNumber);

rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} thumbnail cache test(s) failed.`);
  process.exit(1);
}
console.log("\nAll thumbnail cache tests passed.");
