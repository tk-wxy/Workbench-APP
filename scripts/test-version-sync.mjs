import { compareSemVer, parseSemVer } from "./check-version-sync.mjs";

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}:`, error.message);
  }
}

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log("\n版本门禁 —— SemVer 解析与父提交比较");
test("解析标准三段版本", () => equal(parseSemVer("0.26.3"), [0, 26, 3]));
test("拒绝缺段版本", () => equal(parseSemVer("0.26"), null));
test("拒绝前后缀", () => equal(parseSemVer("v0.26.3-beta"), null));
test("PATCH 递增", () => equal(compareSemVer("0.26.3", "0.26.2"), 1));
test("MINOR 递增", () => equal(compareSemVer("0.27.0", "0.26.9"), 1));
test("相同版本被识别", () => equal(compareSemVer("0.26.3", "0.26.3"), 0));
test("版本倒退被识别", () => equal(compareSemVer("0.25.9", "0.26.0"), -1));

if (failed) process.exit(1);
console.log("全部通过\n");
