// 构建前置检查：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处版本号必须一致。
// 三个文件分属 npm / Cargo / Tauri 三套生态，各自的工具只认自己那份，没法合并成一份，
// 只能靠这个检查在构建期挡住"改了一处忘了改另一处"（历史上就是这样卡死在 0.1.0 的）。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseSemVer(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) throw new Error(`仅支持 MAJOR.MINOR.PATCH：${left} / ${right}`);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function git(args) {
  return spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

export function checkCommittedVersionProgress(currentVersion) {
  const diff = git(["diff", "--quiet", "HEAD", "--"]);
  if (diff.status === 1) return { checked: false, reason: "tracked-worktree-dirty" };
  if (diff.status !== 0) return { checked: false, reason: "git-unavailable" };

  const parent = git(["show", "HEAD^:package.json"]);
  if (parent.status !== 0) return { checked: false, reason: "no-parent" };
  const parentVersion = JSON.parse(parent.stdout).version;
  return {
    checked: true,
    parentVersion,
    advanced: compareSemVer(currentVersion, parentVersion) > 0,
  };
}

export function runVersionCheck() {
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
    console.error("三处需手动同步一致（见 AGENTS.md → .xpc/workflow.md）。");
    return false;
  }

  if (!parseSemVer(pkgVersion)) {
    console.error(`✗ 版本号不是 MAJOR.MINOR.PATCH：${pkgVersion}`);
    return false;
  }

  const progress = checkCommittedVersionProgress(pkgVersion);
  if (progress.checked && !progress.advanced) {
    console.error(`✗ 当前提交版本 v${pkgVersion} 未高于父提交 v${progress.parentVersion}，构建中止。`);
    console.error("每次提交都必须同步递增版本号（R42）。");
    return false;
  }

  const historyNote = progress.checked
    ? `，高于父提交 v${progress.parentVersion}`
    : progress.reason === "tracked-worktree-dirty"
      ? "（开发工作树有改动，提交后将校验版本递增）"
      : "（Git 历史不可用，仅校验三处一致）";
  console.log(`✓ 版本号一致：v${pkgVersion}${historyNote}`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!runVersionCheck()) process.exit(1);
}
