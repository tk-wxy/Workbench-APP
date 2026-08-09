// 模糊搜索：子序列打分器（统一处理模糊 + 缩写）+ 类型词生成 + 命中判定。
// 不依赖 React、无副作用。从 App.tsx 抽出的单一真相源。
export interface MatchResult { score: number; ranges: [number, number][]; } // ranges 基于 target 原始字符串

export function fuzzyScore(query: string, target: string): MatchResult {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 完全子串：最高分直接返回（前缀额外加分）
  const exactIdx = t.indexOf(q);
  if (exactIdx !== -1) return { score: 100 + (exactIdx === 0 ? 20 : 0), ranges: [[exactIdx, exactIdx + q.length - 1]] };

  // 子序列匹配：query 字符按序出现在 target（不要求连续）
  let qi = 0;
  const idxs: number[] = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { idxs.push(ti); qi++; }
  }
  if (qi < q.length) return { score: 0, ranges: [] }; // 子序列不成立

  // 打分：词首 / 连续 / 靠前 加分（缩写匹配靠词首加分自然涌现）
  let score = 10;
  let consecutive = 0;
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i];
    const prev = idx > 0 ? target[idx - 1] : null;
    const isWordStart = idx === 0 || prev === " " || prev === "_" || prev === "-"
      || (target[idx] === target[idx].toUpperCase() && prev !== null && prev === prev.toLowerCase() && prev !== " ");
    if (isWordStart) score += 8;
    if (i > 0 && idxs[i] === idxs[i - 1] + 1) { consecutive++; score += 3 + consecutive; } else { consecutive = 0; }
    score += Math.max(0, 5 - Math.floor(idx / 5));
  }

  // 压缩为连续区间，供高亮
  const ranges: [number, number][] = [];
  let start = idxs[0], end = idxs[0];
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] === end + 1) end = idxs[i];
    else { ranges.push([start, end]); start = end = idxs[i]; }
  }
  ranges.push([start, end]);
  return { score, ranges };
}

// 给条目算"类型词"，让"图片/文本/txt/pdf"等查询能命中对应类型条目（与名称/内容搜索并存）
export function typeKeywords(opts: { type: "text" | "image" | "file"; ext?: string; isImage?: boolean }): string[] {
  const { type, ext, isImage } = opts;
  if (type === "text") return ["文本", "text", "txt"];
  if (type === "image") return ["图片", "image", "img", "png", "jpg"];
  // file：按扩展名归类
  const e = (ext || "").toLowerCase();
  const kw = ["文件", "file"];
  if (isImage || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(e)) kw.push("图片", "image", e);
  else if (["mp4", "mkv", "avi", "mov", "wmv"].includes(e)) kw.push("视频", "video", e);
  else if (["mp3", "wav", "flac", "ogg", "aac", "m4a"].includes(e)) kw.push("音频", "audio", e);
  else if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(e)) kw.push("压缩", "archive", e);
  else if (e === "pdf") kw.push("pdf", "文档");
  else if (["doc", "docx", "odt"].includes(e)) kw.push("文档", "word", e);
  else if (["xls", "xlsx", "csv"].includes(e)) kw.push("表格", "excel", e);
  else if (["ppt", "pptx"].includes(e)) kw.push("幻灯片", "ppt", e);
  else if (["js", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "c", "h", "java", "cs", "html", "css", "json", "yaml", "yml", "xml", "toml"].includes(e)) kw.push("代码", "code", e);
  else if (["exe", "msi", "bat", "cmd", "ps1", "sh"].includes(e)) kw.push("程序", "exe", e);
  else if (["txt", "md", "log", "ini", "cfg", "conf"].includes(e)) kw.push("文本", "txt", e);
  else if (e) kw.push(e);
  return kw;
}

// 通用命中判断：名称/内容优先（子序列模糊），叠加类型词（子串即可）。任一命中即保留。
export function matchItem(query: string, name: string, keywords: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (fuzzyScore(q, name).score > 0) return true;        // 名称/内容（子序列模糊）
  return keywords.some(k => k.toLowerCase().includes(q)); // 类型词（子串即可，"图片""txt"好命中）
}
