import assert from "node:assert/strict";
import { build } from "esbuild";
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
  assert.deepEqual(domain.normalizeStageItemAppearance(items[0]), { id: 1, type: "file", name: "one" });
  assert.deepEqual(domain.normalizeStageItemAppearance(items[2]), { id: 3, type: "image" });
  assert.deepEqual(domain.setStageItemsColorTag(items, [1, 3], "blue").map(item => item.colorTag ?? null), ["blue", "red", "blue"]);
  assert.deepEqual(domain.setStageItemsColorTag(items, [2], null).map(item => item.colorTag ?? null), [null, null, "invalid"]);
  assert.equal(domain.STAGE_COLOR_TAGS.join(","), "red,yellow,blue");
  console.log("中转站手动颜色标记 —— 枚举、批量设置与旧固定字段迁移\n  ✓ 无标记与红黄蓝标签保持稳定\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
