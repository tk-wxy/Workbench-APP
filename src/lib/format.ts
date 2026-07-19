// 展示层纯函数（尺寸格式化 / 相对时间 / 扩展名→类别 / 父目录提取）。
// 不依赖 React、无副作用。从 App.tsx 抽出的单一真相源（搜索结果 + 剪贴板 + 中转条目共用）。
import { makeT } from "../i18n";
type TFunc = ReturnType<typeof makeT>;

// 视为图片的扩展名（中转条目 / 搜索结果的 isImage 判定共用）
export const IMG_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"];

export function fmtSize(b: number) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function ago(ms: number, t: TFunc) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return t("刚刚");
  if (s < 3600) return t("{n}分钟前", { n: Math.floor(s / 60) });
  if (s < 86400) return t("{n}小时前", { n: Math.floor(s / 3600) });
  // 续116：延伸到日/月/年。此前只到小时，3 天前的剪贴板项会显示成「72小时前」。
  // 要用这个函数显示文件修改时间（动辄几个月到几年前）就必须补上。
  if (s < 2592000) return t("{n}天前", { n: Math.floor(s / 86400) });
  // 月按 30 天、年按 365 天切，两者的错位会让 330~365 天显示成「12个月前」
  // （紧接着又跳到「1年前」）。把月档封顶在 11，同时年的边界仍保持真实的 365 天。
  if (s < 31536000) return t("{n}个月前", { n: Math.min(11, Math.floor(s / 2592000)) });
  return t("{n}年前", { n: Math.floor(s / 31536000) });
}

// ago() 的 Unix 秒版本。文件类时间戳是秒，而 ClipItem.time 是毫秒——
// 用这层薄包装免得每个调用点都要操心单位。
export const agoSec = (unixSec: number, t: TFunc) => ago(unixSec * 1000, t);

// 文件类型分类键（扩展名 → 类别）。单一真相源；实际的图标绘制由 icons.tsx 的 FileGlyph 负责。
// 早期直接返回 emoji，为统一到 Solar Bold Duotone 图标，改为只返回类别键。
export type FileCat =
  | "image" | "video" | "audio" | "archive" | "pdf" | "doc" | "sheet" | "ppt"
  | "ebook" | "disk" | "font" | "code" | "exe" | "text" | "folder" | "generic" | "box";

export function fileCategory(ext: string): FileCat {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "psd"].includes(e)) return "image";
  // ⚠ 不能把 "ts" 放进这里（续116 已移除）：video 的判定跑在 code 之前，
  // 导致 TypeScript 文件全被归类成「视频」（图标、徽标色、搜索分段统统错）。
  // MPEG 传输流的 .ts 在开发机上基本不存在，冲突时取 code 才是对的。
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "3gp"].includes(e)) return "video";
  if (["mp3", "wav", "flac", "ogg", "aac", "m4a", "wma", "opus", "aiff", "mid"].includes(e)) return "audio";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz"].includes(e)) return "archive";
  if (e === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf", "pages"].includes(e)) return "doc";
  if (["xls", "xlsx", "csv", "ods", "tsv"].includes(e)) return "sheet";
  if (["ppt", "pptx", "odp", "key"].includes(e)) return "ppt";
  if (["epub", "mobi", "azw", "azw3", "fb2"].includes(e)) return "ebook";
  if (["iso", "img", "dmg", "vhd", "vhdx"].includes(e)) return "disk";
  if (["ttf", "otf", "woff", "woff2", "fon"].includes(e)) return "font";
  if (["js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "cc", "cxx", "c", "h", "hpp", "java", "cs", "php", "rb", "swift", "kt", "scala", "html", "htm", "css", "scss", "sass", "less", "vue", "json", "yaml", "yml", "xml", "toml", "sql", "lua", "r", "dart"].includes(e)) return "code";
  if (["exe", "msi", "bat", "cmd", "ps1", "sh", "appx", "apk", "deb", "rpm"].includes(e)) return "exe";
  if (["txt", "md", "markdown", "log", "ini", "cfg", "conf", "env", "properties"].includes(e)) return "text";
  return "generic";
}

// 增强搜索的结果分组键（续114b）。`fileCategory` 的 16 个分类**对图标合适、对分段太细**，
// 故折叠成能当段落标题用的粗粒度。分类的单一真相源仍是 fileCategory——
// 这里只持有那个映射（不重复维护扩展名列表）。
// 粒度原则：图片/压缩包这类「格式不同但用途相同」的归为一组；
// 冷门格式不单开组，一律落到 "other"。
export type FileGroup = "folder" | "image" | "archive" | "doc" | "code" | "media" | "exe" | "other";

// FileCat → FileGroup 的映射本体（续116 从 fileGroup 抽出）。预览面板的徽标色需要
// **直接由 FileCat 取**而非扩展名（因为文本/图片剪贴板项这类条目没有真实扩展名）。
// 共用这里之后，「徽标颜色 == 该项所属的段落」就自动一致——
// 于是颜色不再只是装饰，而是对分类的再确认。
export function catToGroup(cat: FileCat): FileGroup {
  switch (cat) {
    case "image": return "image";
    case "archive": return "archive";
    case "pdf": case "doc": case "sheet": case "ppt": case "text": case "ebook": return "doc";
    case "code": return "code";
    case "video": case "audio": return "media";
    case "exe": return "exe";
    case "folder": return "folder";
    default: return "other"; // generic / disk / font / box
  }
}

export function fileGroup(ext: string, isDir: boolean): FileGroup {
  return isDir ? "folder" : catToGroup(fileCategory(ext));
}

// Unix 秒 → 「YYYY-MM-DD HH:mm」。用于预览面板的创建/修改时间
// （与 ago() 的相对表述不同，这里是要精确看「什么时候」的场景，故用绝对表示）。
export function fmtDateTime(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 从绝对路径提取父目录（用于搜索结果里显示所在目录）
export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
