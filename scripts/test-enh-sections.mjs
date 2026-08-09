// lib/enhSections.ts 的回归测试（续114b）。无测试框架依赖：用 vite 自带的 esbuild 把 TS 打成
// 临时 ESM 再 node 跑。前端无 test runner，而这段逻辑（分组 + runt 合并 + 名次排序）是分段里
// 唯一「坏了不自明」的部分，值得钉死。
//
//   node scripts/test-enh-sections.mjs
//
// 测的是 App.tsx 真正 import 的那个 groupFiles，不是转写副本。
import { build } from "esbuild";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "enh-sections-"));
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: ["src/lib/enhSections.ts"],
  bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
});
const { groupFiles, groupRanked } = await import(pathToFileURL(outfile).href);

let failed = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${name}`); return; }
  failed++; console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`);
};

// 构造 helper：名次即数组下标
const f = (path, ext, isDir = false) => ({ path, ext, isDir });
const shape = (secs) => secs.map(s => [s.group, s.items.map(i => i.path)]);

console.log("\ngroupFiles —— 分组 / 合并 / 名次序");

// ① 各组都够 MIN=3：按「组内最小名次」排序，而不是固定顺序
eq("段序 = 组内最小名次",
  shape(groupFiles([
    f("a.png","png"), f("b.zip","zip"), f("c.png","png"), f("d.zip","zip"),
    f("e.png","png"), f("f.zip","zip"),
  ], 3)),
  [["image",["a.png","c.png","e.png"]], ["archive",["b.zip","d.zip","f.zip"]]]);

// ②「压缩包在前」也成立——证明顺序真的来自数据而非硬编码的组顺序
eq("最佳匹配在压缩包时压缩包排前",
  shape(groupFiles([
    f("b.zip","zip"), f("d.zip","zip"), f("f.zip","zip"),
    f("a.png","png"), f("c.png","png"), f("e.png","png"),
  ], 3)),
  [["archive",["b.zip","d.zip","f.zip"]], ["image",["a.png","c.png","e.png"]]]);

// ③ 不足 MIN 的组并入 other，且合并后仍按名次排
eq("零散组并入 other 并按名次重排",
  shape(groupFiles([
    f("1.png","png"), f("2.zip","zip"), f("3.docx","docx"),
  ], 3)),
  [["other",["1.png","2.zip","3.docx"]]]);

// ④ 关键回归：最佳匹配是个**落单的**压缩包（不足 MIN → 并入 other），而 other 原本不存在。
//    此时 groups.set("other", …) 会新建 key、追加到 Map 末尾；若依赖插入序，段序就成了
//    [image, other]，最佳匹配被挤到后面 → enhResults[0] 变化 → Enter 打开错的东西。
//    ⚠ 这里必须用「会成为 runt 的组」（.zip）而非直接落 other 的冷门后缀（.mui）：
//      后者在首条就把 other 建好了，Map 插入序恰好正确，测不出这个 bug（本测试初版即如此，
//      反向验证时全绿才发现没牙齿）。
eq("最佳匹配经 runt 并入新建 other 时仍排最前",
  shape(groupFiles([
    f("best.zip","zip"), f("x.png","png"), f("y.png","png"), f("z.png","png"),
  ], 3)),
  [["other",["best.zip"]], ["image",["x.png","y.png","z.png"]]]);

// ⑤ other 自身不受阈值约束（保底桶，1 条也保留成段）
eq("other 不被阈值回收",
  shape(groupFiles([f("only.mui","mui")], 3)),
  [["other",["only.mui"]]]);

// ⑥ 目录独立成组（isDir 优先于扩展名）
eq("目录按 isDir 归组",
  shape(groupFiles([
    f("d1","",true), f("d2","",true), f("d3","",true), f("n.txt","txt"),
  ], 3)),
  [["folder",["d1","d2","d3"]], ["other",["n.txt"]]]);

// ⑦ 不丢不重：分组前后元素集合恒等（含大量输入）
{
  const exts = ["png","zip","docx","ts","mp4","exe","mui","pdf","rs","gif"];
  const many = Array.from({length: 200}, (_,i) => f(`p${i}.${exts[i%exts.length]}`, exts[i%exts.length]));
  const got = groupFiles(many, 3).flatMap(s => s.items.map(i => i.path)).sort();
  eq("200 条输入不丢不重", got.length === 200 && new Set(got).size === 200, true);
}

// ⑧ 空输入
eq("空输入返回空段", shape(groupFiles([], 3)), []);

console.log("\ngroupRanked —— 统一排名结果恢复可导航分段");
const ranked = [
  { id: "best-file", kind: "file" },
  { id: "app-1", kind: "app" },
  { id: "file-2", kind: "file" },
  { id: "clip-1", kind: "clip" },
  { id: "app-2", kind: "app" },
];
const groupedRanked = groupRanked(ranked, item => item.kind);
eq("段序按首次名次且段内稳定",
  groupedRanked.map(s => [s.group, s.items.map(i => i.id)]),
  [["file", ["best-file", "file-2"]], ["app", ["app-1", "app-2"]], ["clip", ["clip-1"]]]);
eq("最佳匹配仍是扁平结果第一项", groupedRanked.flatMap(s => s.items)[0]?.id, "best-file");
eq("空统一结果返回空段", groupRanked([], item => item.kind), []);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 个断言失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
