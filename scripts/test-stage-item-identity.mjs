import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "workbench-stage-identity-"));

try {
  const output = path.join(temp, "stageItemIdentity.mjs");
  await build({ entryPoints: [path.join(root, "src/domain/stageItemIdentity.ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  const { areStageItemsEquivalent } = await import(pathToFileURL(output));
  const file = path => ({ path, name: path, ext: "txt", isImage: false });

  assert.equal(areStageItemsEquivalent(
    { type: "file", items: [file("C:/A.txt")] },
    { type: "file", items: [file("c:\\a.TXT")] },
  ), true);
  assert.equal(areStageItemsEquivalent(
    { type: "file", items: [file("C:/A.txt")] },
    { type: "file", items: [file("C:/A.txt"), file("C:/B.txt")] },
  ), false);
  assert.equal(areStageItemsEquivalent(
    { type: "file", items: [file("C:/A.txt"), file("C:/B.txt")] },
    { type: "file", items: [file("c:/b.txt"), file("c:/a.txt")] },
  ), true);
  assert.equal(areStageItemsEquivalent(
    { type: "file", items: [] },
    { type: "file", items: [] },
  ), false);
  assert.equal(areStageItemsEquivalent({ type: "text", content: "same" }, { type: "text", content: "same" }), true);
  assert.equal(areStageItemsEquivalent({ type: "text", content: "same" }, { type: "text", content: "other" }), false);
  assert.equal(areStageItemsEquivalent({ type: "image", contentFile: "ABC.png" }, { type: "image", contentFile: "abc.PNG" }), true);
  assert.equal(areStageItemsEquivalent({ type: "image", orig_path: "C:/one.png" }, { type: "image", orig_path: "C:/two.png" }), false);

  console.log("中转条目等价 —— 按完整项目而非内部单个文件\n  ✓ 单文件项目代表该文件\n  ✓ 单文件不等于包含它的多文件项目\n  ✓ 多文件项目按完整路径集合比较\n  ✓ 文本与图片身份保持\n全部通过\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
