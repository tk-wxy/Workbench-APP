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
    { id: 3, type: "image", colorTag: "invalid", unused: "yes" },
  ];
  assert.deepEqual(domain.normalizeStageItemAppearance(items[0]), { id: 1, type: "file", name: "one", pinned: true });
  assert.deepEqual(domain.normalizeStageItemAppearance(items[2]), { id: 3, type: "image" });
  assert.deepEqual(domain.normalizeStageItemAppearance({ id: 4, type: "text", pinned: false, colorTag: "yellow" }), { id: 4, type: "text", colorTag: "yellow" });
  assert.deepEqual(domain.normalizeStageItemAppearance({ id: 5, type: "text", unused: true }), { id: 5, type: "text", unused: true });
  assert.deepEqual(domain.normalizeStageItemAppearance({ id: 6, type: "text", unused: false }), { id: 6, type: "text" });
  assert.deepEqual(domain.setStageItemsColorTag(items, [1, 3], "blue").map(item => item.colorTag ?? null), ["blue", "red", "blue"]);
  assert.deepEqual(domain.setStageItemsColorTag(items, [2], null).map(item => item.colorTag ?? null), [null, null, "invalid"]);
  assert.equal(domain.resolveStageColorClick("red", false, "red"), null);
  assert.equal(domain.resolveStageColorClick("red", false, "blue"), "blue");
  assert.equal(domain.resolveStageColorClick(null, true, "yellow"), "yellow");
  assert.equal(domain.shouldRetainStageItem(items[0], false), true);
  assert.equal(domain.shouldRetainStageItem(items[1], false), false);
  assert.equal(domain.shouldRetainStageItem(items[1], true), true);
  assert.deepEqual(domain.filterStageItemsByColor([
    { id: 1, colorTag: "red" }, { id: 2 }, { id: 3, colorTag: "green" },
  ], "green").map(item => item.id), [3]);
  assert.deepEqual(domain.filterStageItemsByColor([{ id: 1 }, { id: 2 }], null).map(item => item.id), [1, 2]);
  const used = domain.markStageItemsUsed([{ id: 1, unused: true }, { id: 2 }, { id: 3, unused: true }], [1, 2]);
  assert.deepEqual(used, [{ id: 1 }, { id: 2 }, { id: 3, unused: true }]);
  assert.equal(domain.STAGE_COLOR_TAGS.join(","), "red,yellow,blue,green,purple");
  const appSource = await readFile(path.join(root, "src/App.tsx"), "utf8");
  assert.match(appSource, /className="stage-color-inline"/);
  assert.match(appSource, /className="stage-color-clear-marker"/);
  assert.doesNotMatch(appSource, />×<\/button>/);
  assert.doesNotMatch(appSource, /kind: "colors"/);
  assert.match(appSource, /stageRef\.current = next;\s*void saveStage\(next\);/);
  assert.match(appSource, /className="stage-color-filter"/);
  assert.match(appSource, /STAGE_COLOR_TAGS\.map\(colorTag/);
  assert.match(appSource, /setStageColorFilter\(null\);\s*closeLauncherPicker/);
  assert.match(appSource, /searchActive: !!search\.trim\(\) \|\| stageColorFilter !== null/);
  assert.match(appSource, /unused: true/);
  assert.match(appSource, /fileEntryToStage\(await startupNative\.getFileInfo\(fp\), false\)/);
  assert.match(appSource, /markStageItemsUsed\(ids\);\s*const dr = dragOutRef\.current/);
  console.log("中转站颜色与首次使用状态 —— 枚举、过滤、内联菜单与持久字段\n  ✓ 无标记、五色标签与单项固定保持稳定\n  ✓ 颜色过滤和归位保持原顺序\n  ✓ 未使用字段仅保留 true，首次使用后按 id 清除\n  ✓ 颜色选择直接位于右键菜单底部\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
