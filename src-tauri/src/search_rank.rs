//! 内置搜索的多字段匹配与结构化排序。
//!
//! Nucleo 只负责字符串贴合度；产品语义（名称 > 别名 > 路径/类型、完整覆盖 > 部分回退）
//! 由本模块显式表达。查询期间只读调用者给出的内存字段，不做任何磁盘访问。

use std::cell::RefCell;

use nucleo_matcher::{
    pattern::{Atom, AtomKind, CaseMatching, Normalization},
    Config, Matcher, Utf32Str,
};

/// 匹配层级。数值只表达严格顺序；Nucleo 分数仅在同层内比较。
const TIER_DIRECT_EXACT: u8 = 10;
const TIER_ACRONYM_EXACT: u8 = 10;
const TIER_PINYIN_EXACT: u8 = 9;
const TIER_DIRECT_PREFIX: u8 = 8;
const TIER_DIRECT_BOUNDARY: u8 = 7;
const TIER_ACRONYM_CONTAINS: u8 = 7;
const TIER_PINYIN_CONTAINS: u8 = 6;
const TIER_DIRECT_SUBSTRING: u8 = 5;
const TIER_AUXILIARY: u8 = 4;
const TIER_DIRECT_FUZZY: u8 = 3;

/// 单字符只接受直接名称命中；路径/模糊匹配会让候选集近乎失控。
const MIN_FUZZY_CHARS: usize = 2;
const MIN_PATH_CHARS: usize = 3;
/// 子序列接受门槛。Nucleo 负责评分，本门槛只阻止短 token 在长名字里散乱穿针。
const FUZZY_GAP_FACTOR: usize = 2;
const FUZZY_GAP_BASE: usize = 2;
/// 三字符以内的内部子串若只占超长名字很小一部分，降到 fuzzy 层，避免 `app` 顶出 wrapper 噪声。
const SHORT_INTERNAL_TOKEN_MAX: usize = 3;
const SHORT_INTERNAL_NAME_FACTOR: usize = 6;

/// 索引条目投影。字段均由索引期准备，查询只借用。
pub(crate) struct SearchCandidate<'a> {
    pub name: &'a str,
    pub name_lower: &'a str,
    pub stem_lower: &'a str,
    pub parent_path: &'a str,
    /// NUL 分隔的紧凑别名：拉丁词首缩写 + 中文全拼/拼音首字母。
    pub aliases: &'a str,
    /// NUL 分隔的明确类型关键词；只按完全相等匹配，避免类型词模糊扩散。
    pub keywords: &'a str,
    pub ext: &'a str,
    pub is_dir: bool,
}

/// 字符串相关性。字段声明顺序就是排序优先级（derive Ord 从前往后比较）。
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SearchScore {
    /// 所有查询词都命中时为 true；部分回退永远排在完整结果之后。
    pub full_match: bool,
    pub matched_tokens: u16,
    /// 木桶原则：多词查询先比较最弱的那个词，避免一个精确词掩盖另一个牵强词。
    pub weakest_tier: u8,
    pub tier_sum: u16,
    /// 同层内才使用 Nucleo 的贴合度。
    pub nucleo_sum: u32,
}

struct QueryToken {
    raw: String,
    chars: usize,
    fuzzy: Atom,
}

pub(crate) struct SearchQuery {
    tokens: Vec<QueryToken>,
}

/// Matcher 带有约 135KB scratch；按查询线程复用，不在逐条匹配中反复分配。
pub(crate) struct MatcherSet {
    name: Matcher,
    char_buf: Vec<char>,
}

impl MatcherSet {
    fn new() -> Self {
        Self {
            name: Matcher::new(Config::DEFAULT),
            char_buf: Vec::new(),
        }
    }
}

thread_local! {
    static MATCHERS: RefCell<MatcherSet> = RefCell::new(MatcherSet::new());
}

pub(crate) fn with_matchers<R>(f: impl FnOnce(&mut MatcherSet) -> R) -> R {
    MATCHERS.with(|cell| f(&mut cell.borrow_mut()))
}

impl SearchQuery {
    /// 普通用户输入按字面处理；不把 `^`、`!`、`$` 偷偷解释成查询语法。
    pub(crate) fn new(query: &str) -> Self {
        let tokens = query
            .trim()
            .to_lowercase()
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|raw| QueryToken {
                chars: raw.chars().count(),
                fuzzy: Atom::new(
                    raw,
                    CaseMatching::Ignore,
                    Normalization::Smart,
                    AtomKind::Fuzzy,
                    false,
                ),
                raw: raw.to_owned(),
            })
            .collect();
        Self { tokens }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub(crate) fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// 返回完整匹配或多词查询的部分回退；单词完全不命中时返回 None。
    pub(crate) fn score(
        &self,
        candidate: SearchCandidate<'_>,
        matchers: &mut MatcherSet,
    ) -> Option<SearchScore> {
        if self.tokens.is_empty() {
            return None;
        }
        if self.tokens.len() == 1 {
            let hit = primary_token_match(&self.tokens[0], &candidate, matchers)?;
            return Some(SearchScore {
                full_match: true,
                matched_tokens: 1,
                weakest_tier: hit.tier,
                tier_sum: hit.tier as u16,
                nucleo_sum: hit.nucleo as u32,
            });
        }

        // 路径只补充名称语义，不能单独制造结果：至少一个 token 必须先命中名称/别名/类型。
        // 这既避免“搜目录词返回目录下所有文件”的噪声，也把昂贵的父路径扫描缩到小候选集。
        if !self
            .tokens
            .iter()
            .any(|token| primary_token_match(token, &candidate, matchers).is_some())
        {
            return None;
        }

        let mut matched = 0u16;
        let mut weakest = u8::MAX;
        let mut tier_sum = 0u16;
        let mut nucleo_sum = 0u32;

        for token in &self.tokens {
            let primary = primary_token_match(token, &candidate, matchers);
            let hit = primary.or_else(|| {
                (self.tokens.len() > 1)
                    .then(|| path_match(token, &candidate))
                    .flatten()
            });
            let Some(hit) = hit else {
                continue;
            };
            matched = matched.saturating_add(1);
            weakest = weakest.min(hit.tier);
            tier_sum = tier_sum.saturating_add(hit.tier as u16);
            nucleo_sum = nucleo_sum.saturating_add(hit.nucleo as u32);
        }

        if matched == 0 {
            return None;
        }
        let full_match = matched as usize == self.tokens.len();
        Some(SearchScore {
            full_match,
            matched_tokens: matched,
            weakest_tier: weakest,
            tier_sum,
            nucleo_sum,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct TokenMatch {
    tier: u8,
    nucleo: u16,
}

fn primary_token_match(
    token: &QueryToken,
    candidate: &SearchCandidate<'_>,
    matchers: &mut MatcherSet,
) -> Option<TokenMatch> {
    let mut best = direct_name_match(token, candidate, matchers);

    if best.is_some_and(|hit| hit.tier == TIER_DIRECT_EXACT) {
        return best;
    }

    for alias in candidate.aliases.split('\0').filter(|s| !s.is_empty()) {
        let (exact_tier, contains_tier, text) = if let Some(text) = alias.strip_prefix("a:") {
            (TIER_ACRONYM_EXACT, TIER_ACRONYM_CONTAINS, text)
        } else if let Some(text) = alias.strip_prefix("p:") {
            (TIER_PINYIN_EXACT, TIER_PINYIN_CONTAINS, text)
        } else {
            // 兼容进程内热更新前的旧快照；下次索引重建后都会带类型前缀。
            (TIER_PINYIN_EXACT, TIER_PINYIN_CONTAINS, alias)
        };
        best = best.max(alias_match(token, text, exact_tier, contains_tier));
    }

    if (!candidate.ext.is_empty() && candidate.ext == token.raw)
        || candidate.keywords.split('\0').any(|word| word == token.raw)
        || type_alias_matches(&token.raw, candidate.is_dir, candidate.ext)
    {
        best = best.max(Some(TokenMatch {
            tier: TIER_AUXILIARY,
            nucleo: (token.chars.min(u16::MAX as usize)) as u16,
        }));
    }
    best
}

fn path_match(token: &QueryToken, candidate: &SearchCandidate<'_>) -> Option<TokenMatch> {
    if token.chars < MIN_PATH_CHARS || candidate.parent_path.is_empty() {
        return None;
    }
    find_ignore_ascii_case(candidate.parent_path, &token.raw).map(|pos| TokenMatch {
        tier: TIER_AUXILIARY,
        nucleo: literal_score(token.chars, pos),
    })
}

fn direct_name_match(
    token: &QueryToken,
    candidate: &SearchCandidate<'_>,
    matchers: &mut MatcherSet,
) -> Option<TokenMatch> {
    let raw = token.raw.as_str();

    if candidate.name_lower == raw || candidate.stem_lower == raw {
        return Some(TokenMatch {
            tier: TIER_DIRECT_EXACT,
            nucleo: literal_score(token.chars, 0),
        });
    }
    if candidate.name_lower.starts_with(raw) || candidate.stem_lower.starts_with(raw) {
        return Some(TokenMatch {
            tier: TIER_DIRECT_PREFIX,
            nucleo: literal_score(token.chars, 0),
        });
    }
    if let Some(pos) = candidate.name_lower.find(raw) {
        if is_name_boundary(candidate.name, candidate.name_lower, pos) {
            return Some(TokenMatch {
                tier: TIER_DIRECT_BOUNDARY,
                nucleo: literal_score(token.chars, pos),
            });
        }
        let name_chars = candidate.stem_lower.chars().count();
        let tier = if token.chars <= SHORT_INTERNAL_TOKEN_MAX
            && name_chars > token.chars.saturating_mul(SHORT_INTERNAL_NAME_FACTOR)
        {
            TIER_DIRECT_FUZZY
        } else {
            TIER_DIRECT_SUBSTRING
        };
        return Some(TokenMatch {
            tier,
            nucleo: literal_score(token.chars, pos),
        });
    }

    if token.chars < MIN_FUZZY_CHARS {
        return None;
    }
    // 廉价紧凑度预筛先挡掉绝大多数不可能/散乱候选，Nucleo 只给小候选集精排。
    if subsequence_gaps(raw, candidate.name_lower)
        .is_none_or(|gaps| gaps > token.chars * FUZZY_GAP_FACTOR + FUZZY_GAP_BASE)
    {
        return None;
    }
    let haystack = Utf32Str::new(candidate.name_lower, &mut matchers.char_buf);
    let nucleo = token.fuzzy.score(haystack, &mut matchers.name)?;
    Some(TokenMatch {
        tier: TIER_DIRECT_FUZZY,
        nucleo,
    })
}

fn alias_match(
    token: &QueryToken,
    alias: &str,
    exact_tier: u8,
    contains_tier: u8,
) -> Option<TokenMatch> {
    let raw = token.raw.as_str();
    if alias == raw {
        Some(TokenMatch {
            tier: exact_tier,
            nucleo: literal_score(token.chars, 0),
        })
    } else {
        alias.find(raw).map(|pos| TokenMatch {
            tier: contains_tier,
            nucleo: literal_score(token.chars, pos),
        })
    }
}

fn literal_score(chars: usize, byte_pos: usize) -> u16 {
    let base = chars.saturating_mul(32).min(u16::MAX as usize) as u16;
    base.saturating_sub(byte_pos.min(u16::MAX as usize) as u16)
}

/// ASCII 查询在 UTF-8 路径中做不分配的大小写无关子串查找。
fn find_ignore_ascii_case(haystack: &str, needle_lower: &str) -> Option<usize> {
    if needle_lower.is_empty() {
        return Some(0);
    }
    if needle_lower.is_ascii() {
        return haystack
            .as_bytes()
            .windows(needle_lower.len())
            .position(|window| window.eq_ignore_ascii_case(needle_lower.as_bytes()));
    }
    haystack.find(needle_lower)
}

fn type_alias_matches(token: &str, is_dir: bool, ext: &str) -> bool {
    if is_dir {
        return matches!(token, "folder" | "dir" | "directory" | "文件夹" | "目录");
    }
    if matches!(token, "file" | "文件") {
        return true;
    }
    match token {
        "image" | "picture" | "图片" | "图像" => matches!(
            ext,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tif" | "tiff"
        ),
        "document" | "doc" | "文档" => matches!(
            ext,
            "txt" | "md" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "rtf"
        ),
        "archive" | "压缩包" => matches!(ext, "zip" | "7z" | "rar" | "tar" | "gz"),
        "code" | "代码" => matches!(
            ext,
            "rs" | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "py"
                | "java"
                | "c"
                | "cpp"
                | "h"
                | "hpp"
                | "go"
                | "html"
                | "css"
                | "json"
                | "toml"
                | "yaml"
                | "yml"
        ),
        "video" | "视频" => matches!(ext, "mp4" | "mkv" | "mov" | "avi" | "webm"),
        "audio" | "音频" => matches!(ext, "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg"),
        "executable" | "exe" | "可执行文件" => {
            matches!(ext, "exe" | "lnk" | "msi" | "bat" | "cmd")
        }
        _ => false,
    }
}

fn is_name_boundary(name: &str, name_lower: &str, pos: usize) -> bool {
    if pos == 0 {
        return true;
    }
    let delimiter = name_lower[..pos]
        .chars()
        .next_back()
        .is_some_and(|c| matches!(c, ' ' | '_' | '-' | '.' | '(' | '[' | ')' | ']'));
    if delimiter || !name.is_ascii() || !name_lower.is_ascii() {
        return delimiter;
    }
    let bytes = name.as_bytes();
    bytes[pos].is_ascii_uppercase() && bytes[pos - 1].is_ascii_lowercase()
}

/// 返回贪心子序列命中的空隙数；只作为宽松接受门槛，不参与排名。
fn subsequence_gaps(needle: &str, haystack: &str) -> Option<usize> {
    let mut wanted = needle.chars();
    let mut current = wanted.next()?;
    let mut first = None;
    let mut matched = 0usize;
    for (idx, ch) in haystack.chars().enumerate() {
        if ch == current {
            let first_idx = *first.get_or_insert(idx);
            matched += 1;
            match wanted.next() {
                Some(next) => current = next,
                None => return Some(idx - first_idx + 1 - matched),
            }
        }
    }
    None
}

/// 构建索引期紧凑别名。只存可搜索字符串，不存前端高亮使用的 UTF-16 回映射表。
pub(crate) fn build_search_aliases(name_stem: &str, include_pinyin: bool) -> Box<str> {
    let mut aliases: Vec<String> = latin_acronyms(name_stem)
        .into_iter()
        .map(|alias| format!("a:{alias}"))
        .collect();
    if include_pinyin && !name_stem.is_ascii() {
        for variant in crate::pinyin_util::derive(name_stem) {
            push_alias(&mut aliases, format!("p:{}", variant.full));
            push_alias(&mut aliases, format!("p:{}", variant.initials));
        }
    }
    aliases.join("\0").into_boxed_str()
}

fn latin_acronyms(name: &str) -> Vec<String> {
    let mut boundary = String::new();
    let mut capitals = String::new();
    let mut previous_ascii_alnum = false;
    let mut previous_ascii_lower = false;

    for ch in name.chars() {
        if !ch.is_ascii_alphanumeric() {
            previous_ascii_alnum = false;
            previous_ascii_lower = false;
            continue;
        }
        if !previous_ascii_alnum || (ch.is_ascii_uppercase() && previous_ascii_lower) {
            boundary.push(ch.to_ascii_lowercase());
        }
        if ch.is_ascii_uppercase() {
            capitals.push(ch.to_ascii_lowercase());
        }
        previous_ascii_alnum = true;
        previous_ascii_lower = ch.is_ascii_lowercase();
    }

    let mut out = Vec::new();
    push_alias(&mut out, boundary);
    push_alias(&mut out, capitals);
    out
}

fn push_alias(aliases: &mut Vec<String>, alias: String) {
    let searchable = alias
        .strip_prefix("a:")
        .or_else(|| alias.strip_prefix("p:"))
        .unwrap_or(&alias);
    if searchable.chars().count() >= 2 && !aliases.contains(&alias) {
        aliases.push(alias);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OwnedCandidate {
        name: String,
        name_lower: String,
        stem_lower: String,
        parent: String,
        aliases: Box<str>,
        keywords: Box<str>,
        ext: String,
        is_dir: bool,
    }

    impl OwnedCandidate {
        fn file(path: &str, name: &str) -> Self {
            let name_lower = name.to_lowercase();
            let (stem_lower, ext) = name_lower
                .rsplit_once('.')
                .map(|(stem, ext)| (stem.to_owned(), ext.to_owned()))
                .unwrap_or_else(|| (name_lower.clone(), String::new()));
            let parent = path
                .strip_suffix(name)
                .unwrap_or_default()
                .trim_end_matches(['\\', '/'])
                .to_owned();
            Self {
                aliases: build_search_aliases(
                    name.strip_suffix(&format!(".{ext}")).unwrap_or(name),
                    true,
                ),
                keywords: "".into(),
                name: name.to_owned(),
                name_lower,
                stem_lower,
                parent,
                ext,
                is_dir: false,
            }
        }

        fn view(&self) -> SearchCandidate<'_> {
            SearchCandidate {
                name: &self.name,
                name_lower: &self.name_lower,
                stem_lower: &self.stem_lower,
                parent_path: &self.parent,
                aliases: &self.aliases,
                keywords: &self.keywords,
                ext: &self.ext,
                is_dir: self.is_dir,
            }
        }
    }

    fn rank(query: &str, items: &[OwnedCandidate]) -> Vec<usize> {
        let query = SearchQuery::new(query);
        with_matchers(|matchers| {
            let mut scored: Vec<(SearchScore, usize)> = items
                .iter()
                .enumerate()
                .filter_map(|(idx, item)| query.score(item.view(), matchers).map(|s| (s, idx)))
                .collect();
            scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            scored.into_iter().map(|(_, idx)| idx).collect()
        })
    }

    #[test]
    fn golden_exact_acronym_and_short_noise() {
        let items = [
            OwnedCandidate::file("C:\\x\\app.exe", "app.exe"),
            OwnedCandidate::file(
                "C:\\x\\quarterly-wrapper-config-backup.xml",
                "quarterly-wrapper-config-backup.xml",
            ),
            OwnedCandidate::file(
                "C:\\x\\Advanced Photo Processor.exe",
                "Advanced Photo Processor.exe",
            ),
            OwnedCandidate::file("C:\\x\\App Store Helper.log", "App Store Helper.log"),
        ];
        let order = rank("app", &items);
        assert_eq!(order[0], 0, "完全一致必须第一: {order:?}");
        let acronym = order.iter().position(|i| *i == 2).unwrap();
        let wrapper = order.iter().position(|i| *i == 1).unwrap();
        assert!(acronym < wrapper, "词首缩写应高于长单词内部噪声: {order:?}");
    }

    #[test]
    fn golden_vsc_acronym() {
        let items = [
            OwnedCandidate::file("C:\\Apps\\Visual Studio Code.lnk", "Visual Studio Code.lnk"),
            OwnedCandidate::file(
                "C:\\x\\version-source-cache.txt",
                "version-source-cache.txt",
            ),
        ];
        assert_eq!(rank("vsc", &items).first(), Some(&0));
    }

    #[test]
    fn golden_chinese_full_pinyin_and_initials() {
        let items = [
            OwnedCandidate::file("D:\\docs\\会议纪要.docx", "会议纪要.docx"),
            OwnedCandidate::file("D:\\docs\\海外纪要.docx", "海外纪要.docx"),
        ];
        assert_eq!(rank("huiyi", &items).first(), Some(&0));
        assert_eq!(rank("hyjy", &items).first(), Some(&0));
    }

    #[test]
    fn golden_split_pinyin_beats_english_noise() {
        let items = [
            OwnedCandidate::file("D:\\docs\\文档.docx", "文档.docx"),
            OwnedCandidate::file(
                "D:\\x\\windows-notify-data-gathering.wav",
                "windows-notify-data-gathering.wav",
            ),
        ];
        assert_eq!(rank("wen dang", &items).first(), Some(&0));
    }

    #[test]
    fn golden_parent_path_and_extension_intent() {
        let items = [
            OwnedCandidate::file("D:\\dev\\workbench-app\\report.md", "report.md"),
            OwnedCandidate::file("D:\\archive\\report.pdf", "report.pdf"),
        ];
        assert_eq!(rank("workbench report", &items).first(), Some(&0));
        assert_eq!(rank("report pdf", &items).first(), Some(&1));
    }

    #[test]
    fn golden_explicit_type_intent() {
        let items = [
            OwnedCandidate::file("D:\\media\\sunset.png", "sunset.png"),
            OwnedCandidate::file("D:\\docs\\report.pdf", "report.pdf"),
        ];
        assert_eq!(rank("图片", &items), vec![0]);
        assert_eq!(rank("文档", &items), vec![1]);
    }

    #[test]
    fn golden_full_match_precedes_partial_fallback() {
        let items = [
            OwnedCandidate::file("D:\\docs\\report-2023.md", "report-2023.md"),
            OwnedCandidate::file("D:\\docs\\report-2024.md", "report-2024.md"),
        ];
        let order = rank("report 2024", &items);
        assert_eq!(order, vec![1, 0]);
    }

    #[test]
    fn aliases_are_compact_and_cover_camel_case() {
        let aliases = build_search_aliases("Visual Studio Code", false);
        assert!(aliases.split('\0').any(|a| a == "a:vsc"));
        let aliases = build_search_aliases("MyApp", false);
        assert!(aliases.split('\0').any(|a| a == "a:ma"));
        assert!(!aliases.contains("Visual"));
    }
}
