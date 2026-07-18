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

// 文件类型分类键（拡張名 → カテゴリ）。単一真相源；実際のアイコン描画は icons.tsx の FileGlyph が担う。
// 以前は絵文字を直接返していたが、Solar Bold Duotone アイコンに統一するためカテゴリ键のみを返すよう変更。
export type FileCat =
  | "image" | "video" | "audio" | "archive" | "pdf" | "doc" | "sheet" | "ppt"
  | "ebook" | "disk" | "font" | "code" | "exe" | "text" | "folder" | "generic" | "box";

export function fileCategory(ext: string): FileCat {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "psd"].includes(e)) return "image";
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "ts", "3gp"].includes(e)) return "video";
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

// 増強検索の結果分组键（続114b）。`fileCategory` の 16 分類は**アイコン用に細かすぎる**ため、
// セクション見出しに使える粗い単位へ畳む。分类の単一真相源は依然 fileCategory —— ここは
// その写像だけを持つ（拡張子リストを二重管理しない）。
// 粒度の方針：画像/圧縮包のように「形式が違っても用途が同じ」ものは 1 グループ、
// mui のような冷門形式に専用グループは作らず "other" へ落とす。
export type FileGroup = "folder" | "image" | "archive" | "doc" | "code" | "media" | "exe" | "other";

export function fileGroup(ext: string, isDir: boolean): FileGroup {
  if (isDir) return "folder";
  switch (fileCategory(ext)) {
    case "image": return "image";
    case "archive": return "archive";
    case "pdf": case "doc": case "sheet": case "ppt": case "text": case "ebook": return "doc";
    case "code": return "code";
    case "video": case "audio": return "media";
    case "exe": return "exe";
    default: return "other"; // generic / disk / font / box
  }
}

// 絶対パスから親ディレクトリを抽出（検索結果のディレクトリ表示用）
export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
