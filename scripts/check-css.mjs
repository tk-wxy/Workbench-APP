// CSS 语法闸（续115b）。
//
// 起因：一次编辑在**已闭合的注释之后**多写了 `*/`，产出非法 CSS。CSS 解析器错误恢复时会把
// 紧跟其后的整个规则块一并吞掉——当时被吞的是 `.enh-preview` 的定位与外观，界面直接错乱。
// 而 `vite build` 对此只报 **warning、退出码仍是 0**，看起来完全正常。
//
// 所以：把 CSS 语法问题升级为**硬失败**。esbuild 是 vite 自带的，无新依赖。
//
//   node scripts/check-css.mjs
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "src";
const files = readdirSync(dir).filter(f => f.endsWith(".css")).map(f => join(dir, f));
if (!files.length) { console.log("✓ 无 CSS 文件"); process.exit(0); }

let bad = 0;
for (const file of files) {
  // write:false —— 只解析不产出；minify 会启用完整的 CSS 词法分析，才能抓到注释/括号类错误
  const r = await build({ entryPoints: [file], bundle: false, write: false, minify: true, logLevel: "silent" });
  const msgs = [...r.warnings, ...r.errors];
  if (msgs.length) {
    bad += msgs.length;
    for (const m of msgs) {
      const loc = m.location ? `${file}:${m.location.line}:${m.location.column}` : file;
      console.error(`✗ ${loc}  ${m.text}`);
      if (m.location?.lineText) console.error(`    ${m.location.lineText.trim()}`);
    }
  }
}

if (bad) {
  console.error(`\nCSS 语法检查未通过（${bad} 处）。注意：非法 CSS 会让解析器连同后续规则一起丢弃，\n表现为"某个组件样式整块失效"，而非报错。\n`);
  process.exit(1);
}
console.log(`✓ CSS 语法检查通过（${files.length} 个文件）`);
