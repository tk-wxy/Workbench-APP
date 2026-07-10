// 重複していたインライン SVG を集約（copy / check / trash / open / pin は 12px 前後で 4〜6 箇所ずつ重複していた）。
// 全て stroke="currentColor" なので色は親の color を継承する（既存の挙動そのまま）。
// 一度きり使用の gear（設定）/ folder は個別事情が強いので App.tsx 側に残す。
type IconProps = { size?: number };

// line-style アイコン共通属性
const stroke = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconCheck = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} {...stroke}><polyline points="20 6 9 17 4 12" /></svg>
);

export const IconCopy = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} {...stroke}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconTrash = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} {...stroke}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

export const IconOpen = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} {...stroke}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

export const IconPin = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} {...stroke}>
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14l-2-4V7a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v6z" />
  </svg>
);

// 検索アイコンだけ className="search-icon-svg" + strokeLinecap 無しで運用されていたので合わせる
export const IconSearch = ({ size = 16 }: IconProps) => (
  <svg className="search-icon-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
