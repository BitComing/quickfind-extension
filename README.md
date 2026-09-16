# QuickFind

选中网页文字后，在选区末端显示一个半透明搜索按钮。点击按钮即可打开默认分组中的搜索源，也可以展开自定义分组。文本框和文本域中的选中内容同样会触发搜索按钮，搜索面板会以鼠标位置为中心展开。网页右键菜单支持将选中文字、链接标题或当前页面位置直接带入搜索列表。

## 本地安装

1. 安装依赖并构建：

   ```
   npm install
   npm run build
   ```

2. 打开 Chrome 或 Edge 的扩展管理页（Chrome 地址为 `chrome://extensions`）。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择 `.output/chrome-mv3` 目录。
5. 打开任意网页，选中一段文字即可使用。

点击浏览器工具栏里的 QuickFind 图标，可以在搜索框中输入内容、读取当前页面选中文字、查看搜索历史并切换分组。内置搜索源包括 Google、百度、谷歌学术、DuckDuckGo、360 搜索、搜狗、Google AI Mode、Bing、Yandex、哔哩哔哩、小红书、X、YouTube、知乎、抖音、豆包和 DeepSeek。选项页侧边栏按主题分为六页：选中文字、常驻搜索栏、搜索源与分组、LLM 对话、历史记录、无限大纲笔记。两个搜索列表共用同一份搜索源与分组数据（都在「搜索源与分组」里编辑），默认组中的搜索源和自定义组可混排并拖动排序。

搜索源与分组里除了搜索源，还可以放「特殊功能按钮」：选中文字浮层、常驻搜索栏和弹窗都会出现这些按钮，点下去不跳搜索而是直接做一件事。目前有「复制」和「笔记」两枚——「笔记」把当前内容存到无限大纲笔记的第一行，方便边读边收。

无限大纲笔记按 Workflowy 风格设计：Enter 新建同级项目，Shift+Enter 插入换行，Tab/Shift+Tab 调整层级，Ctrl/⌘+Enter 标记完成，空行 Backspace 删除项目，行首 Backspace 合并到上一项目。每个项目都可以收起、拖到另一个项目之前/内部/之后，或进入“专注”视图；工具栏提供搜索计数、撤销/重做、全部展开/收起、JSON 和 Markdown 导入导出。数据保存在当前浏览器的 IndexedDB 中，并兼容旧版本地存储格式。

常驻搜索列表默认支持 Google、百度、谷歌学术、DuckDuckGo、360 搜索、搜狗、Bing、Yandex、知乎、哔哩哔哩和抖音，在对应站点的搜索结果页自动固定在页面顶部居中显示，并显示当前搜索文本；鼠标移开 3 秒后收起为细长把手，悬停即可展开。站点和默认分组展示数量均独立保存。自定义 URL 请填写 `{query}` 的模板。所有更改会自动保存。豆包源会打开新对话并尝试填入内容，不自动发送消息，实际效果取决于豆包当前页面结构和登录状态。

常驻搜索框本来没有内容时，页面上新选中的文字会自动填入其中：选中即代表「想搜的内容」，省去手工粘贴。这里的「没有内容」只包括空值和「最近一次搜索」的兜底填充——页面自带搜索框里的值、URL 中的查询参数、以及用户自己输入过的内容都不会被覆盖。填入的值会一直留在框里，直到页面出现真实查询或路由变化。

## 工程结构

| 路径 | 说明 |
| --- | --- |
| `entrypoints/` | 扩展源码：`popup/`、`options/`、`content/`、`background.ts` |
| `shared/` | 跨入口共享的代码：`settings.ts`（领域类型）、`search-actions.ts`（特殊功能按钮定义）、`notes.ts`（笔记存储形状与「存到第一行」的写入规则） |
| `public/` | 静态资源（图标等），构建时原样拷贝 |
| `types/` | 补充类型声明 |
| `scripts/` | 工程脚本：`typecheck.mjs`（类型检查与类型债务度量） |
| `legacy/` | 迁移前的根目录平铺产物，仅作回退参照，不参与构建 |
| `.output/` | 构建产物（忽略提交） |
| `.typecheck-baseline.json` | 类型债务基线，随代码提交，用于阻止债务增加 |

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | WXT 开发模式，改动自动重载 |
| `npm run build` | 构建 Chrome MV3 扩展，输出到 `.output/chrome-mv3` |
| `npm run build:firefox` | 构建 Firefox 扩展 |
| `npm run compile` | 仅做 TypeScript 类型检查 |
| `npm run typecheck` | 同上，但在结果中标注被 `@ts-nocheck` 屏蔽的文件 |
| `npm run typecheck:debt` | 额外量出被屏蔽文件的真实错误数（见「类型债务」） |
| `npm run check` | 提交前门禁：类型债务超过基线即失败 |
| `npm run build:raw` | 直接调用 `wxt build`，见下方说明 |

## 构建说明

`npm run build` 执行的是 `build.mjs`，而不是直接调用 `wxt build`。

原因是本机环境下 Vite 写出的 JS / CSS / HTML 产物会在 WXT 收尾汇总之前被移除：
`writeBundle` 钩子执行时磁盘上 9 个产物全部完好，WXT 统计产物时已全部 `ENOENT`，
而 `fs` 层的 `rm` / `unlink` / `rmdir` / `rename` 都观测不到对应调用，因此无法从
WXT 侧规避。

为此 `wxt.config.ts` 中的 `qf-snapshot` 插件在 `writeBundle`（文件内容为最终态、
且仍在磁盘上的唯一时机）把产物读入内存，由 `build.mjs` 在构建结束后写回，
并校验 `manifest.json` 引用的每个文件确实存在。两个文件头部都有相应注释。

在不需要这层兜底的环境里，可以直接使用 `npm run build:raw`。

## 类型检查

`tsc` 只检查没有被 `// @ts-nocheck` 屏蔽的文件，被屏蔽的文件对它完全静默。
因此在补完类型标注之前，`npm run compile` 会「干净通过」却什么也没检查。
`scripts/typecheck.mjs` 用来消除这个盲区：

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 运行 tsc，报告未被屏蔽文件的真实结果 |
| `npm run typecheck:debt` | 额外做一次影子检查：临时移除屏蔽标记后编译，量出每个文件的真实错误数，再原样恢复 |
| `npm run check` | 提交前门禁。债务超过 `.typecheck-baseline.json` 即退出码 1 |
| `npm run typecheck:baseline` | 债务减少后刷新基线 |

影子检查会短暂改写源文件，恢复逻辑放在 `finally` 与进程退出钩子里双重兜底，
恢复后按内容比对确认与原文完全一致；不一致会明确指出文件并以退出码 2 终止。
基线只允许下降，除此之外不要给它附加别的含义。

## 类型债务与迭代路线

项目已从早期「根目录平铺手写文件」迁移到 WXT + TypeScript 工程结构，
`entrypoints/` 为唯一源码入口。补类型标注分阶段进行，以下为实测数字：

| 文件 | 行数 | 真实类型错误 | 状态 |
| --- | --- | --- | --- |
| `entrypoints/popup/main.ts` | 208 | 0 | 已补全，可作样板 |
| `entrypoints/options/main.ts` | 1642 | 550 | 待处理 |
| `entrypoints/content/index.ts` | 2972 | 620 | 待处理 |
| 合计 | — | **1170** | — |

错误构成中约 85% 集中在四类：

| 错误码 | 数量 | 含义 |
| --- | --- | --- |
| TS7006 | 317 | 函数参数为隐式 `any`，补标注即可 |
| TS2339 | 268 | 在 `Element` 上访问不存在的属性，多为 DOM 查询缺泛型 |
| TS18047 | 219 | 值可能为 `null` |
| TS7005 | 185 | 变量为隐式 `any`，且按引用次数重复计数 |

建议的推进顺序：

1. 先确认 `shared/settings.ts` 里该文件用到的数据结构，再逐文件补标注；
   缺什么类型往那里加，不要各自造一套。
2. 处理顺序按文件从小到大：options → content。每完成一个文件，删掉它的
   `// @ts-nocheck`，然后跑一次 `npm run typecheck:baseline` 刷新基线。
3. 补标注时不要顺手改逻辑。类型层面无法证明非空的位置，用 `!` 断言并在注释里
   写明依据（`entrypoints/popup/main.ts` 就是这么做的），而不是加默认值或提前返回——
   那会让「补类型」变成「改行为」，两种风险混在一起就说不清是哪一边出的问题。

`entrypoints/popup/main.ts` 可作为样板。它的改动只增标注：改动前后各构建一次，
产物文件名与体积（含内容哈希）完全一致，可用这个办法复核任何一次纯类型改动。

其余未完成项：

- `types/node-lite.d.ts` 是本地最小 Node 类型声明。若能安装 `@types/node`，
  可删除该文件并在 `tsconfig.json` 的 `types` 中加入 `"node"`。
- `entrypoints/popup/main.ts` 中的 `escapeHtml` 没有调用点，属迁移残留，确认后可删。
- 三个入口仍是迁移前的 IIFE + `'use strict'` 写法，`popup/main.ts` 与 `options/main.ts`
  里多个函数挤在同一行。可读性拆分放在类型补齐之后单独做。
