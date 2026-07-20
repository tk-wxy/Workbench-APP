// 汉字 → 拼音派生（增强搜索的拼音匹配，续131）。
//
// 为什么放 Rust 而不是前端：
// ① Tier2（文件索引 8 万+ 条）将来要拼音化只能在 Rust 做——两处各写一套必然分裂；
// ② 前端 bundle 不用背一张汉字表。
// 派生结果由前端缓存（键=原名），只在 apps/stage/clipboard 列表变化时重算，
// **不进逐键匹配路径**——匹配本身在 JS 里对派生好的 ASCII 串做，是纯字符串操作。
//
// 契约：只有**含汉字**的名字才有派生结果（`derive` 返回 None），纯英文名走原有的直接匹配即可。
//
// ── 多音字：为什么必须展开成多个变体 ────────────────────────────────────────
// 首版只取每个字的首选读音，实测立刻踩雷：`乐` 的首选读音是 `le`（乐趣），于是
// 「音乐」派生成 `yinle`/`yl`——**搜 `yinyue` 或「网易云音乐」搜 `wyyyy` 全部落空**。
// 这不是边角情形，是中文应用名里最常见的一类。
//
// 故改为：逐字取**全部读音**，做笛卡尔展开得到多个候选串，前端逐个匹配取最高分。
// 展开有硬上限 `MAX_VARIANTS`——「重庆长安银行」这类多个多音字连排会指数爆炸。
// 超限后剩余的字退回首选读音（截断而非放弃：短名字全展开，长名字至少覆盖前几个多音字）。

use serde::Serialize;

/// 单个名字最多展开出多少个拼音变体。
/// 8 覆盖 3 个二读音字（2³）；再大对匹配质量几乎无增益，却让前端每次匹配多跑几轮。
const MAX_VARIANTS: usize = 8;

/// 一个拼音变体。`map`/`imap` 是**回映射**：给出派生串里每个位置来自原名的哪个位置——
/// 前端命中高亮要标在原名上，没有它就只能不高亮。
///
/// ⚠️ 下标一律是 **UTF-16 code unit**（= JS 字符串的下标），不是 Rust 的 char 下标。
/// 唯一的消费者是前端高亮，让它拿到就能直接用；若按 char 计，名字里带一个 emoji
/// （JS 里占 2 个单位）之后的高亮就会整体偏移——这类 bug 极难在中文名上被发现。
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PinyinVariant {
    /// 全拼，非汉字原样保留并小写：「QQ音乐」→ `qqyinyue`
    pub full: String,
    /// 首字母，非汉字里的字母数字也计入：「QQ音乐」→ `qqyy`
    pub initials: String,
    /// `full` 的第 i 个 char ← 原名的第 map[i] 个 char
    pub map: Vec<u32>,
    /// `initials` 的第 i 个 char ← 原名的第 imap[i] 个 char
    pub imap: Vec<u32>,
}

impl PinyinVariant {
    /// 把一个字的某个读音（或一个非汉字字符的小写形）追加到该变体。
    /// `initial` 决定这段是否贡献首字母（空格/标点不贡献）。
    fn push_seg(&mut self, seg: &str, src: u32, initial: bool) {
        for c in seg.chars() {
            self.full.push(c);
            // 每个 UTF-16 单位一条映射（见结构体注释）。拼音是纯 ASCII，
            // 走到 len_utf16()==2 的只有原样保留下来的非汉字字符（emoji 等）。
            for _ in 0..c.len_utf16() {
                self.map.push(src);
            }
        }
        if initial {
            if let Some(c) = seg.chars().next() {
                self.initials.push(c);
                for _ in 0..c.len_utf16() {
                    self.imap.push(src);
                }
            }
        }
    }
}

/// 派生一个名字的全部拼音变体。不含汉字时返回空 Vec（前端据此跳过，不白占缓存）。
pub fn derive(name: &str) -> Vec<PinyinVariant> {
    use pinyin::ToPinyinMulti;
    let mut variants: Vec<PinyinVariant> = vec![PinyinVariant::default()];
    let mut has_han = false;

    let mut src_u16 = 0u32; // 原名中的 UTF-16 下标（见 PinyinVariant 注释）
    for ch in name.chars() {
        let src = src_u16;
        src_u16 += ch.len_utf16() as u32;
        // 该字符的候选读音段。汉字 = 全部读音（去重后）；非汉字 = 其小写形本身。
        let (segs, initial) = match ch.to_pinyin_multi() {
            Some(multi) => {
                has_han = true;
                let mut v: Vec<String> = Vec::new();
                for p in multi {
                    let s = p.plain().to_string();
                    // 必须去重：不同声调的 plain 形常常相同（好 hǎo/hào → 都是 "hao"），
                    // 不去重会白白翻倍变体数、把预算浪费在完全一样的串上。
                    if !v.contains(&s) {
                        v.push(s);
                    }
                }
                (v, true)
            }
            None => {
                // 非汉字原样保留（小写），让「QQ音乐」能被 `qqyy` / `qqyinyue` 命中。
                // 首字母串只收字母数字：空格/标点进去只会稀释缩写匹配。
                (vec![ch.to_lowercase().collect::<String>()], ch.is_alphanumeric())
            }
        };
        if segs.is_empty() {
            continue;
        }

        // 展开：预算够就笛卡尔乘，不够就只用首选读音（截断，不放弃后续字符）
        if segs.len() > 1 && variants.len() * segs.len() <= MAX_VARIANTS {
            let mut next = Vec::with_capacity(variants.len() * segs.len());
            for v in &variants {
                for s in &segs {
                    let mut c = v.clone();
                    c.push_seg(s, src, initial);
                    next.push(c);
                }
            }
            variants = next;
        } else {
            for v in variants.iter_mut() {
                v.push_seg(&segs[0], src, initial);
            }
        }
    }

    if has_han {
        variants
    } else {
        Vec::new()
    }
}

/// 批量派生。前端一次把「新出现的名字」全传进来，避免逐条 IPC 往返。
/// 返回与入参**等长**的数组，无汉字的位置是空数组。
#[tauri::command]
pub fn to_pinyin_batch(names: Vec<String>) -> Vec<Vec<PinyinVariant>> {
    names.iter().map(|n| derive(n)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fulls(name: &str) -> Vec<String> {
        derive(name).into_iter().map(|v| v.full).collect()
    }
    fn initials(name: &str) -> Vec<String> {
        derive(name).into_iter().map(|v| v.initials).collect()
    }

    #[test]
    fn pure_ascii_has_no_derivation() {
        // 纯英文名不该占缓存，也不该走拼音路径
        assert!(derive("Photoshop").is_empty());
        assert!(derive("").is_empty());
        assert!(derive("2024_report.md").is_empty());
    }

    #[test]
    fn common_name_derives_expected_reading() {
        // 不断言变体**个数**：字典里冷僻读音比想象中多（「信」除 xin 外还有 shen），
        // 钉死个数只会让测试随字典版本翻车。要保证的是「常用读法一定在里面」。
        assert!(fulls("微信").contains(&"weixin".to_string()));
        assert!(initials("微信").contains(&"wx".to_string()));
    }

    /// 首版就是栽在这里：乐的首选读音是 le，只取首选就搜不到「音乐」
    #[test]
    fn heteronym_covers_both_readings() {
        assert!(fulls("音乐").contains(&"yinyue".to_string()));
        assert!(fulls("音乐").contains(&"yinle".to_string()));
        assert!(initials("网易云音乐").contains(&"wyyyy".to_string()));
    }

    #[test]
    fn mixed_ascii_and_han() {
        assert!(fulls("QQ音乐").contains(&"qqyinyue".to_string()));
        assert!(initials("QQ音乐").contains(&"qqyy".to_string()));
    }

    #[test]
    fn punctuation_kept_in_full_but_not_initials() {
        // 空格进 full、不进 initials
        assert!(fulls("网易云 音乐").contains(&"wangyiyun yinyue".to_string()));
        assert!(initials("网易云 音乐").contains(&"wyyyy".to_string()));
    }

    #[test]
    fn variant_count_is_capped() {
        // 多个多音字连排（重/长/行/银 等）不得指数爆炸
        for name in ["重庆长安银行乐重长行", "会计长期行乐重"] {
            let n = derive(name).len();
            assert!(n <= MAX_VARIANTS, "{name} 展开出 {n} 个变体，超过上限");
            assert!(n >= 1);
        }
    }

    /// 回映射是高亮的唯一依据，逐字符对齐必须成立——**每个**变体都要成立
    #[test]
    fn map_points_back_to_source_chars() {
        // 含 emoji 的名字专门入列：它是 char 下标与 UTF-16 下标分道扬镳的唯一场景
        for name in ["QQ音乐", "网易云 音乐", "重庆银行", "🎵音乐播放器"] {
            let src_len = name.encode_utf16().count();
            for v in derive(name) {
                assert_eq!(v.map.len(), v.full.encode_utf16().count(), "{name}: map 与 full 不等长");
                assert_eq!(v.imap.len(), v.initials.encode_utf16().count(), "{name}: imap 与 initials 不等长");
                assert!(v.map.iter().all(|&i| (i as usize) < src_len), "{name}: map 越界");
                assert!(v.imap.iter().all(|&i| (i as usize) < src_len), "{name}: imap 越界");
                // 回映射必须单调不减（拼音是按源字符顺序拼出来的）
                assert!(v.map.windows(2).all(|w| w[0] <= w[1]), "{name}: map 非单调");
            }
        }
        // 具体对齐：full = q q y i n y u e → 源下标 0 1 2 2 2 3 3 3
        let v = derive("QQ音乐").into_iter().find(|v| v.full == "qqyinyue").unwrap();
        assert_eq!(v.map, vec![0, 1, 2, 2, 2, 3, 3, 3]);
        assert_eq!(v.imap, vec![0, 1, 2, 3]);
    }

    /// 真实中文应用名的派生一览（`cargo test --lib probe_derive -- --ignored --nocapture`）。
    /// 断言只钉"能搜到"这一条底线，输出供人眼核对读音是否离谱。
    #[test]
    #[ignore]
    fn probe_derive_real_app_names() {
        let samples = [
            ("微信", "wx"),
            ("网易云音乐", "wyyyy"),
            ("腾讯会议", "txhy"),
            ("钉钉", "dd"),
            ("百度网盘", "bdwp"),
            ("向日葵远程控制", "xrkyckz"),
            ("剪映专业版", "jyzyb"),
            ("QQ音乐", "qqyy"),
            ("搜狗输入法", "sgsrf"),
            ("同花顺", "ths"),
        ];
        for (name, want_initials) in samples {
            let vs = derive(name);
            let fulls: Vec<&str> = vs.iter().map(|v| v.full.as_str()).collect();
            let inits: Vec<&str> = vs.iter().map(|v| v.initials.as_str()).collect();
            println!("{name:<12} 变体 {:>2} 个  全拼 {fulls:?}\n{:16}首字母 {inits:?}", vs.len(), "");
            assert!(
                inits.contains(&want_initials),
                "{name}: 首字母缩写 {want_initials} 不在 {inits:?} 里——用户打这个缩写会搜不到"
            );
        }
    }

    /// 派生一批名字的**实测开销**（`cargo test --lib probe_derive_cost -- --ignored --nocapture`）。
    /// 量的是「一次列表变化要付多少」以及「前端要缓存多大」——两者都是审查这个功能时会被问到的数。
    #[test]
    #[ignore]
    fn probe_derive_cost() {
        // 合成一批规模接近真实应用列表的中文名（真实机器上约 141 条，其中中文名约 1/3）
        let base = [
            "微信", "网易云音乐", "腾讯会议", "钉钉", "百度网盘", "向日葵远程控制",
            "剪映专业版", "QQ音乐", "搜狗输入法", "同花顺", "爱奇艺", "哔哩哔哩",
            "有道词典", "石墨文档", "迅雷", "格式工厂", "驱动精灵", "火绒安全软件",
            "网易有道翻译", "美图秀秀",
        ];
        let names: Vec<String> = (0..150).map(|i| base[i % base.len()].to_string()).collect();

        let t0 = std::time::Instant::now();
        let out: Vec<Vec<PinyinVariant>> = names.iter().map(|n| derive(n)).collect();
        let elapsed = t0.elapsed();

        let variants: usize = out.iter().map(|v| v.len()).sum();
        // 前端缓存的近似体积：字符串 + 两张映射表（映射表按 u32 记，JS number 更大，这里给下界）
        let bytes: usize = out
            .iter()
            .flatten()
            .map(|v| v.full.len() + v.initials.len() + (v.map.len() + v.imap.len()) * 4)
            .sum();
        println!(
            "派生 {} 个名字：{:?}（每个 {:.1}µs）\n变体合计 {} 个（均 {:.1} 个/名）\n净载荷约 {} 字节（{:.1} KB）",
            names.len(),
            elapsed,
            elapsed.as_secs_f64() * 1e6 / names.len() as f64,
            variants,
            variants as f64 / names.len() as f64,
            bytes,
            bytes as f64 / 1024.0
        );
        assert!(!out.is_empty());
    }

    #[test]
    fn batch_preserves_length_and_empties() {
        let r = to_pinyin_batch(vec!["微信".into(), "Chrome".into(), "文档".into()]);
        assert_eq!(r.len(), 3);
        assert!(!r[0].is_empty());
        assert!(r[1].is_empty()); // 纯英文 → 空
        assert!(r[2].iter().any(|v| v.initials == "wd"));
    }
}
