# Workbench App

Windows 全屏"第二桌面"工具——热键呼出覆盖全屏的功能界面，用完优雅消失。

**功能**：应用启动器 · 文件中转 · 剪贴板历史 · 全盘文件搜索

## 技术栈

Tauri 2.0 + React 18 + TypeScript + Tailwind CSS

## 运行

```bash
npm install
npm run tauri dev    # 开发
npm run tauri build  # 打包
```

## 快捷键

| 操作 | 默认热键 |
|------|---------|
| 呼出/隐藏 | `Ctrl+Space`（长按=按住显示松开关闭，短按=切换） |
| 增强搜索 | `Ctrl+K` |
| 关闭/返回 | `Esc` |

热键可在设置面板自定义。

## 搜索

- **内置引擎**：遍历常用目录建内存索引，子序列模糊匹配，µs 级查询
- **Everything**：可选切换 Everything 引擎，全盘毫秒级搜索。设置 → 搜索 → 选 Everything 即可

## 许可

MIT
