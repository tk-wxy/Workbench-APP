// 性能测量桩（增强搜索性能专项）：分段时延 + JS heap 采样。
//
// 门控：localStorage["wb.perf"] === "1"（模块加载时读一次）。**故意不用 import.meta.env.DEV**——
// dev 模式有 StrictMode 双调用与开发版 React 调度开销，测量一律在 release 构建上做，
// 所以开关必须是运行时的。关闭时每个调用点只剩一次布尔检查，release 默认零开销零日志。
//
// 汇总经 `perf_report` 命令落到 Rust stderr，与 Rust 侧 `[perf]` 分段（WORKBENCH_PERF=1）同一日志流。
// 手动入口：门控开启时挂 window.__wbPerf（`.dump()` 出汇总、`.heap("tag")` 采 JS heap）。

export interface PerfSample {
  tag: string;
  ms: number;
}

interface MarkEntry {
  t: number;
  used: Set<string>; // 同一 mark 实例下每个 tag 只记一次（防方向键等后续 effect 重跑污染「输入→绘制」）
}

export interface PerfTracerOptions {
  on: boolean;
  now: () => number;
  heapBytes: () => number | null;
  report: (lines: string[]) => void;
  capacity?: number;
}

export interface PerfTracer {
  readonly on: boolean;
  setOn: (on: boolean) => void;
  mark: (name: string) => void;
  since: (mark: string, tag: string) => number | null;
  time: <T>(tag: string, fn: () => T) => T;
  record: (tag: string, ms: number) => void;
  heap: (tag: string) => void;
  dump: () => string[];
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, idx)];
}

/** 纯函数：按 tag 分组出 n / p50 / p95 / max 汇总行，node 测试直接断言。 */
export function summarizeSamples(samples: PerfSample[]): string[] {
  const byTag = new Map<string, number[]>();
  for (const s of samples) {
    const list = byTag.get(s.tag);
    if (list) list.push(s.ms);
    else byTag.set(s.tag, [s.ms]);
  }
  const lines: string[] = [];
  for (const [tag, values] of byTag) {
    values.sort((a, b) => a - b);
    const fmt = (v: number) => v.toFixed(1);
    lines.push(
      `${tag} n=${values.length} p50=${fmt(percentile(values, 0.5))} p95=${fmt(percentile(values, 0.95))} max=${fmt(values[values.length - 1])}`,
    );
  }
  return lines;
}

export function createPerfTracer({ on, now, heapBytes, report, capacity = 500 }: PerfTracerOptions): PerfTracer {
  let enabled = on; // 可变：release 无 devtools，启动后经 perf_env_on 由 WORKBENCH_PERF=1 翻开
  const samples: PerfSample[] = [];
  const marks = new Map<string, MarkEntry>();

  const record = (tag: string, ms: number) => {
    if (!enabled) return;
    samples.push({ tag, ms });
    if (samples.length > capacity) samples.splice(0, samples.length - capacity);
  };

  return {
    get on() { return enabled; },
    setOn(v) { enabled = v; },
    mark(name) {
      if (!enabled) return;
      marks.set(name, { t: now(), used: new Set() });
    },
    since(mark, tag) {
      if (!enabled) return null;
      const entry = marks.get(mark);
      if (!entry || entry.used.has(tag)) return null;
      entry.used.add(tag);
      const ms = now() - entry.t;
      record(tag, ms);
      return ms;
    },
    time(tag, fn) {
      if (!enabled) return fn();
      const t0 = now();
      try {
        return fn();
      } finally {
        record(tag, now() - t0);
      }
    },
    record,
    heap(tag) {
      if (!enabled) return;
      const bytes = heapBytes();
      if (bytes != null) record(`heap:${tag}`, bytes / (1024 * 1024)); // MB，汇总行直接可读
    },
    dump() {
      if (!enabled) return [];
      const lines = summarizeSamples(samples);
      if (typeof console !== "undefined" && console.table) {
        console.table(samples.reduce<Record<string, number[]>>((acc, s) => {
          (acc[s.tag] ??= []).push(s.ms);
          return acc;
        }, {}));
      }
      try {
        report(lines);
      } catch {
        // 汇总上报失败不影响测量本身
      }
      return lines;
    },
  };
}

/** 全局单例：真实环境下由 wb.perf 门控；测试用 createPerfTracer 注入假时钟。 */
export const perf = createPerfTracer({
  on: typeof localStorage !== "undefined" && localStorage.getItem("wb.perf") === "1",
  now: () => performance.now(),
  heapBytes: () => (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? null,
  report: (lines) => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("perf_report", { lines }))
      .catch(() => {});
  },
});

function exposeGlobal() {
  if (typeof window !== "undefined") (window as unknown as { __wbPerf: PerfTracer }).__wbPerf = perf;
}

if (perf.on) {
  exposeGlobal();
} else {
  // release 构建无 devtools、设不了 localStorage：WORKBENCH_PERF=1 经 Rust 侧同时翻开前端分段。
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("perf_env_on"))
    .then((envOn) => { if (envOn) { perf.setOn(true); exposeGlobal(); } })
    .catch(() => {});
}
