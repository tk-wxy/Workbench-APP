import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = await mkdtemp(join(tmpdir(), "workbench-search-sync-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: [join(process.cwd(), "src/domain/searchSynchronization.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "error",
});
const domain = await import(`file:///${outfile.replaceAll("\\", "/")}`);
let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.error(`  ✗ ${name}: ${error.message}`); } };
const equal = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const t = (key, vars) => vars ? key.replace("{n}", String(vars.n)) : key;

console.log("\n搜索同步领域 —— 拼音键集、裁剪与动态投影");
const apps = [{ name: "微信", path: "wx", icon: null }, { name: "Code", path: "code", icon: null }];
const stage = [{ id: 7, type: "file", name: "会议记录", items: [{ path: "D:/会议.docx", name: "会议.docx", ext: "docx", isImage: false }] }];
const clipboard = [{ type: "image", time: 9 }, { type: "text", time: 10, content: "English only" }];
test("只收集当前列表中的中文显示名", () => equal([...domain.collectPinyinNames(apps, stage, clipboard, t)].sort(), ["会议记录", "图片", "微信"]));
test("裁剪移除陈旧拼音键", () => equal(Object.keys(domain.prunePinyinTable({ 微信: [], 旧名字: [] }, new Set(["微信"]))), ["微信"]));
test("同键集保持原引用", () => { const table = { 微信: [] }; if (domain.prunePinyinTable(table, new Set(["微信"])) !== table) throw new Error("引用发生变化"); });
const projection = domain.buildSearchProjection({ apps, stage, clipboard, appUsage: { wx: { count: 5, last_used: 1000 } }, nowSeconds: 1000, t });
test("投影覆盖 app/stage/clip 且 key 稳定", () => equal(projection.map(item => `${item.kind}:${item.key}`), ["app:wx", "app:code", "stage:7", "clip:9", "clip:10"]));
test("文件夹/类型关键词与使用 boost 保持", () => { if (projection[0].boost !== 400 || !projection[2].keywords.includes("docx") || !projection[3].keywords.includes("图片")) throw new Error("投影语义漂移"); });

await rm(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("全部通过\n");
