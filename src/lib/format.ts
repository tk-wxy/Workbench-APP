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
  if (s < 86400) return t("{n}小时前", { n: Math.floor(s / 3600) });
  // 続116：日/月/年まで延長。以前は時間止まりで、3 日前のクリップが「72小时前」になっていた。
  // ファイル更新時刻（数か月〜数年前が普通）をこの関数で出すには必須。
  if (s < 2592000) return t("{n}天前", { n: Math.floor(s / 86400) });
  // 月は 30 日固定・年は 365 日で切るため、両者の食い違いで 330〜365 日が「12个月前」になる
  // （その直後に「1年前」へ飛ぶ）。11 で頭打ちにして、年境界は本物の 365 日のまま保つ。
  if (s < 31536000) return t("{n}个月前", { n: Math.min(11, Math.floor(s / 2592000)) });
  return t("{n}年前", { n: Math.floor(s / 31536000) });
}

// Unix 秒版の ago()。ファイル系のタイムスタンプは秒、ClipItem.time はミリ秒 —— 単位の取り違えを
// 呼び出し側で毎回気にしないための薄いラッパ。
export const agoSec = (unixSec: number, t: TFunc) => ago(unixSec * 1000, t);

// 文件类型分类键（拡張名 → カテゴリ）。単一真相源；実際のアイコン描画は icons.tsx の FileGlyph が担う。
// 以前は絵文字を直接返していたが、Solar Bold Duotone アイコンに統一するためカテゴリ键のみを返すよう変更。
export type FileCat =
  | "image" | "video" | "audio" | "archive" | "pdf" | "doc" | "sheet" | "ppt"
  | "ebook" | "disk" | "font" | "code" | "exe" | "text" | "folder" | "generic" | "box";

export function fileCategory(ext: string): FileCat {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "psd"].includes(e)) return "image";
  // ⚠ "ts" をここに入れてはいけない（続116 で除去）：video 判定が code より先に走るため、
  // TypeScript ファイルが全部「動画」に分類されていた（アイコン・徽標色・検索セクションすべて）。
  // MPEG トランスポートストリームの .ts は開発機ではまず存在せず、衝突時は code を採るのが正しい。
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

// 増強検索の結果分组键（続114b）。`fileCategory` の 16 分類は**アイコン用に細かすぎる**ため、
// セクション見出しに使える粗い単位へ畳む。分类の単一真相源は依然 fileCategory —— ここは
// その写像だけを持つ（拡張子リストを二重管理しない）。
// 粒度の方針：画像/圧縮包のように「形式が違っても用途が同じ」ものは 1 グループ、
// mui のような冷門形式に専用グループは作らず "other" へ落とす。
export type FileGroup = "folder" | "image" | "archive" | "doc" | "code" | "media" | "exe" | "other";

// FileCat → FileGroup の写像本体（続116 で fileGroup から抽出）。プレビュー面板の徽標色は
// 拡張子ではなく **FileCat から直接**引きたい（テキスト/画像クリップのように実体の拡張子が
// 無い項目があるため）。ここを共用することで「徽標の色 == その項目が属するセクション」が
// 自動的に一致する —— 色が単なる装飾ではなく分類の再確認になる。
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

// Unix 秒 → 「YYYY-MM-DD HH:mm」。プレビュー面板の作成/更新時刻用（ago() の相対表記と違い、
// ここは「いつ」を正確に見たい場面なので絶対表記）。
export function fmtDateTime(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 絶対パスから親ディレクトリを抽出（検索結果のディレクトリ表示用）
export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
