// 构建前置检查：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处版本号必须一致。
// 三个文件分属 npm / Cargo / Tauri 三套生态，各自的工具只认自己那份，没法合并成一份，
// 只能靠这个检查在构建期挡住"改了一处忘了改另一处"（历史上就是这样卡死在 0.1.0 的）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
const tauriVersion = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf-8")).version;
const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf-8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = {
  "package.json": pkgVersion,
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
};

if (new Set(Object.values(versions)).size > 1) {
  console.error("✗ 版本号不一致，构建中止：");
  for (const [file, v] of Object.entries(versions)) console.error(`  ${file}: ${v ?? "(未找到)"}`);
  console.error("三处需手动同步一致（见 CLAUDE.md「版本号规则」）。");
  process.exit(1);
}

console.log(`✓ 版本号一致：v${pkgVersion}`);
