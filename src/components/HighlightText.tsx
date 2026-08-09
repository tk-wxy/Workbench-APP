type HighlightVariant = "name" | "body";

export default function HighlightText({ text, ranges, variant = "name" }: { text: string; ranges: [number, number][]; variant?: HighlightVariant }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<span key={`${start}-${end}`} className={`search-highlight search-highlight-${variant}`}>{text.slice(start, end + 1)}</span>);
    cursor = end + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
