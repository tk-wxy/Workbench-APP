// 表示系の純関数（サイズ整形 / 相対時刻 / 拡張子→絵文字アイコン / 親ディレクトリ抽出）。
// React 非依存・副作用なし。App.tsx から切り出した単一真相源（搜索結果 + 剪贴板 + 中転条目で共用）。
import { makeT } from "../i18n";
type TFunc = ReturnType<typeof makeT>;

// 画像とみなす拡張子（中転条目/検索結果の isImage 判定に共用）
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
  return t("{n}小时前", { n: Math.floor(s / 3600) });
}

// 拡張名 → タイプ絵文字（検索結果 + 剪贴板カード共用、単一真相源）
export function extIcon(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "psd"].includes(e)) return "🖼️";
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "ts", "3gp"].includes(e)) return "🎬";
  if (["mp3", "wav", "flac", "ogg", "aac", "m4a", "wma", "opus", "aiff", "mid"].includes(e)) return "🎵";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz"].includes(e)) return "🗜️";
  if (e === "pdf") return "📕";
  if (["doc", "docx", "odt", "rtf", "pages"].includes(e)) return "📝";
  if (["xls", "xlsx", "csv", "ods", "tsv"].includes(e)) return "📊";
  if (["ppt", "pptx", "odp", "key"].includes(e)) return "📽️";
  if (["epub", "mobi", "azw", "azw3", "fb2"].includes(e)) return "📚";
  if (["iso", "img", "dmg", "vhd", "vhdx"].includes(e)) return "💿";
  if (["ttf", "otf", "woff", "woff2", "fon"].includes(e)) return "🔤";
  if (["js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "cc", "cxx", "c", "h", "hpp", "java", "cs", "php", "rb", "swift", "kt", "scala", "html", "htm", "css", "scss", "sass", "less", "vue", "json", "yaml", "yml", "xml", "toml", "sql", "lua", "r", "dart"].includes(e)) return "💻";
  if (["exe", "msi", "bat", "cmd", "ps1", "sh", "appx", "apk", "deb", "rpm"].includes(e)) return "⚙️";
  if (["txt", "md", "markdown", "log", "ini", "cfg", "conf", "env", "properties"].includes(e)) return "📃";
  return "📎";
}

// 絶対パスから親ディレクトリを抽出（検索結果のディレクトリ表示用）
export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
