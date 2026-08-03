import { memo, useEffect, useState, type RefObject } from "react";
import type { Lang } from "../i18n";
import { IconSearch } from "../icons";
import { comboLabel } from "../lib/hotkey";

type Translate = (zh: string, vars?: Record<string, string | number>) => string;

// 时钟自持 state，分钟 tick 不牵动 App 主树。
export const Clock = memo(function Clock({ lang }: { lang: Lang }) {
  const [time, setTime] = useState("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setTime(new Date().toLocaleTimeString(lang === "en" ? "en-US" : "zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }));
      const now = new Date();
      const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
      timer = setTimeout(tick, msToNextMinute);
    };
    tick();
    return () => clearTimeout(timer);
  }, [lang]);

  return <span className="clock">{time}</span>;
});

interface WorkbenchSearchHeaderProps {
  search: string;
  searchRef: RefObject<HTMLInputElement>;
  t: Translate;
  onSearchChange: (value: string) => void;
}

// 顶栏右侧仍留在 App 作为 shell 组合槽；品牌与搜索是无业务状态的纯视图。
export const WorkbenchSearchHeader = memo(function WorkbenchSearchHeader({
  search,
  searchRef,
  t,
  onSearchChange,
}: WorkbenchSearchHeaderProps) {
  return <>
    <div className="top-left"><div className="logo">W</div><span className="app-title">Workbench</span></div>
    <div className="top-center">
      <div className="global-search">
        <IconSearch size={16}/>
        <input
          ref={searchRef}
          className="search-field"
          placeholder={t("搜索应用、中转、剪贴板…")}
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          spellCheck={false}
        />
      </div>
    </div>
  </>;
});

interface WorkbenchFooterProps {
  hotkeyCombo: string;
  enhancedHotkey: string;
  enhancedOpen: boolean;
  version: string;
  t: Translate;
}

export const WorkbenchFooter = memo(function WorkbenchFooter({
  hotkeyCombo,
  enhancedHotkey,
  enhancedOpen,
  version,
  t,
}: WorkbenchFooterProps) {
  const coreCount = typeof navigator === "undefined" ? "?" : (navigator.hardwareConcurrency ?? "?");
  return (
    <footer className="bottom-bar">
      <div className="bot-left"><span className="sys-dot"/><span>CPU {coreCount} {t("核")}</span></div>
      <div className="bot-center"><kbd>{comboLabel(hotkeyCombo)}</kbd> {t("切换")} · <kbd>{comboLabel(enhancedHotkey)}</kbd> {enhancedOpen ? t("界面搜索") : t("增强搜索")} · <kbd>Esc</kbd> {t("关闭")} · <kbd>↑↓</kbd> {t("导航")} · <kbd>Enter</kbd> {t("启动")}</div>
      <div className="bot-right"><span>Workbench v{version}</span></div>
    </footer>
  );
});
