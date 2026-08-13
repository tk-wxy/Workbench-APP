import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-stage-color-tag-"));
try {
  const output = path.join(temp, "domain.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/stageColorTag.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const domain = await import(pathToFileURL(output));
  const items = [
    { id: 1, type: "file", name: "one", pinned: true },
    { id: 2, type: "text", content: "two", colorTag: "red" },
    { id: 3, type: "image", colorTag: "invalid" },
  ];
  assert.deepEqual(domain.normalizeStageItemAppearance(items[0]), { id: 1, type: "file", name: "one", pinned: true });
  assert.deepEqual(domain.normalizeStageItemAppearance(items[2]), { id: 3, type: "image" });
  assert.deepEqual(domain.normalizeStageItemAppearance({ id: 4, type: "text", pinned: false, colorTag: "yellow" }), { id: 4, type: "text", colorTag: "yellow" });
  assert.deepEqual(domain.setStageItemsColorTag(items, [1, 3], "blue").map(item => item.colorTag ?? null), ["blue", "red", "blue"]);
  assert.deepEqual(domain.setStageItemsColorTag(items, [2], null).map(item => item.colorTag ?? null), [null, null, "invalid"]);
  assert.equal(domain.shouldRetainStageItem(items[0], false), true);
  assert.equal(domain.shouldRetainStageItem(items[1], false), false);
  assert.equal(domain.shouldRetainStageItem(items[1], true), true);
  assert.equal(domain.STAGE_COLOR_TAGS.join(","), "red,yellow,blue");
  const appSource = await readFile(path.join(root, "src/App.tsx"), "utf8");
  assert.match(appSource, /className="stage-color-inline"/);
  assert.doesNotMatch(appSource, /kind: "colors"/);
  assert.match(appSource, /stageRef\.current = next;\s*void saveStage\(next\);/);
  console.log("中转站手动颜色标记 —— 枚举、内联菜单、批量设置与固定字段\n  ✓ 无标记、红黄蓝标签与单项固定保持稳定\n  ✓ 颜色选择直接位于右键菜单底部\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
