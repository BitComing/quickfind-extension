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

点击浏览器工具栏里的 QuickFind 图标，可以在搜索框中输入内容、读取当前页面选中文字、查看搜索历史并切换分组。内置搜索源包括 Google、百度、谷歌学术、DuckDuckGo、360 搜索、搜狗、Google AI Mode、Bing、Yandex、哔哩哔哩、小红书、X、YouTube、知乎、抖音、豆包和 DeepSeek；全新安装默认只启用小红书、Bing、知乎、哔哩哔哩，另有一个「视频」分组放抖音，其余内置源在「搜索源与分组」里打开即用。选项页侧边栏按主题分为五页：常用设置、搜索源与分组、LLM 对话、历史记录、关于（「无限大纲笔记」开启时另有第六页）。两个搜索列表共用同一份搜索源与分组数据（都在「搜索源与分组」里编辑），默认组中的搜索源和自定义组可混排并拖动排序。搜索源图标点开是一个独立的图标弹窗：预览当前图标，并从「获取网站图标」「上传图片」「粘贴链接」三种方式里选一种，换完可以「恢复默认」；列表行上只保留编辑与删除两个按钮。常用设置里的「语言」可选简体中文或 English，切换后选项页、弹窗与页面内的浮层 / 常驻栏 / 对话窗口一起换语言，并随浏览器账号同步到其他设备。

搜索源与分组里除了搜索源，还可以放「特殊功能按钮」：选中文字浮层、常驻搜索栏和弹窗都会出现这些按钮，点下去不跳搜索而是直接做一件事。目前有「复制」和「问 ai」两枚——「复制」复制当前内容，「问 ai」把内容作为首个问题在网页中弹出对话窗口。这些按钮在分组里与搜索源同级：有复选框（可多选，批量移动、批量删除都认 `action:<id>`）、改名按钮、删除按钮、「仅图标」开关和启用开关；改名、仅图标、停用都落盘在 `specialActions` 里（形如 `{ name?, iconOnly?, enabled? }`，只记与默认不同的项），浮层、常驻栏与弹窗按它渲染——停用的按钮仍留在分组里，随时可以再打开。网页里的搜索源图标支持右键菜单：可以按这一次的选择决定「本标签打开」还是「新建标签打开」，不改动常驻栏的默认开关。

「关于」页现在只有一个「版本」区块：付费会员整块下线——套餐卡、激活码、购买说明都还留在 `entrypoints/options/index.html` 里（带 `data-paid` 标记），但默认整块 `hidden`，页面上读不到任何价格、二维码或微信号。开关是 `shared/license.ts` 的 `PAID_FEATURES_ENABLED`（现为 `false`），它同时管两件事：界面收起付费内容；配额函数 `groupQuota` / `sourceQuota` 一律返回「不限」，分组与搜索源都不再有上限（旧版是免费 2 个分组、20 个已启用搜索源）。改成 `true` 就原样恢复付费版面与那两条上限，其他文件一行都不用动。激活、续期、停用的实现全部保留，只是开关关闭时 `maybeRefreshLicense` 提前返回，不会对着没在用的会员发请求；购买说明与两张收款码仍留在 DOM 里，开关打开后照旧生效（收款码是 `public/pay/` 下的私有素材，加载失败会自动摘掉整块扫码区域）。

激活码由服务端的 `license-server/scripts/gencodes.py` 生成（`issue --email … --plan yearly` 出码，`list`/`reset`/`revoke`/`extend` 管后续）。校验在服务端：激活时把邮箱与码发给 `api.kpopcha.top`，服务端查库核验（库里只有 HMAC 哈希）并签发 ES256 许可证，扩展内置公钥用 WebCrypto 离线验签——服务器宕机或用户断网时，已激活的会员照常可用。码与邮箱绑定、一个码最多可在 5 台设备上激活，在一台设备上点「清除激活码」会把那一台的名额退回来。实现、发码命令与运维见服务端的 `license-server/README.md`——服务端目录同样不进本仓库，只在本机与服务器上维护。改格式时 `shared/license.ts` 与 `license-server/app/crypto.py` 必须一起改；`tests/verify-about-free-2026-11-10.cjs` 现在验的是「付费内容确实只是隐藏」与「两条配额都放开」，激活链路本身由 `license-server` 自己的测试覆盖。

选中文字后的触发图标在两类页面上同样可用，这两处都曾是「有些地方选不中」的来源：**长选区**（整页 Ctrl+A 也不再有长度上限）、**页面自己的 shadow DOM 内**（浏览器会让 `window.getSelection()` 退化成 collapsed，需在影子根内取选区）。反向的边界同样明确：**只有屏幕上真的看得见的选区才会弹出图标**——页面用离屏元素做复制时留下的选区、被删掉或重渲染掉的选区、滚出视口的选区都不触发；图标显示期间选区若被页面销毁（节点被删、消息重渲染、祖先被隐藏），图标会在 0.25 秒内自行收起，而不是留在原地。插件只作用于当前这个网页本身：内容脚本不注入任何 iframe，页面里嵌的客服挂件、广告位、播放器、预览窗里选中文字不会弹出浮层——那些框架里的浮层会被框架边界裁成一小块，看起来像「插件在小窗口里弹窗」。

内容脚本只在 HTML 文档里初始化。直接打开 `.xml` / `.svg` 这类文档时（对象存储的 `AccessDenied` 错误页就是最常见的例子：`https://static.deepseek.com/` 返回的是一段 `<Error>` XML），文档里没有 HTML 元素接口，浮层无从挂载，脚本会静默退出而不是抛错；`text/plain` 是例外——浏览器把它渲染成 HTML 文档，正文照样可选、浮层照常出现。

无限大纲笔记与网页右侧的「随心问」侧栏已下线，开关在 `shared/features.ts`（`OUTLINE_NOTES_ENABLED` / `PAGE_SIDEBAR_ENABLED`）。下线只摘界面：笔记的模型层、存储与「时间戳认领 + 双向同步」逻辑都还在，`OUTLINE_NOTES_ENABLED` 改回 `true` 就原样恢复；页面里不再生成滑杆与侧栏，但「问 ai」的对话窗口照常弹出（它只是借用同一个宿主承载，本身不是侧栏）。

「问 ai」的对话窗口与设置页同一套中性色：底、卡片、气泡都是白与浅灰，只有发送按钮、链接与焦点环保留主题绿。窗口的几何记忆有一处硬约束——`clampLlmWindowRect` 在元素还没进布局时（`offsetWidth` 为 0）必须直接放过：否则会按「0×0 放在左上角」把窗口压到 280×240 并贴到 (0,0)，而那正好是侧栏关掉时「问 ai」路径的时序。

常驻搜索列表默认支持 Google、百度、谷歌学术、DuckDuckGo、360 搜索、搜狗、Bing、Yandex、知乎、哔哩哔哩和抖音，在对应站点的搜索结果页自动固定在页面顶部居中显示，并显示当前搜索文本；鼠标移开 3 秒后收起为细长把手，悬停即可展开。站点和默认分组展示数量均独立保存。自定义 URL 请填写 `{query}` 的模板。所有更改会自动保存。豆包源会打开新对话并尝试填入内容，不自动发送消息，实际效果取决于豆包当前页面结构和登录状态。

常驻搜索框本来没有内容时，页面上新选中的文字会自动填入其中：选中即代表「想搜的内容」，省去手工粘贴。这里的「没有内容」只包括空值和「最近一次搜索」的兜底填充——页面自带搜索框里的值、URL 中的查询参数、以及用户自己输入过的内容都不会被覆盖。填入的值会一直留在框里，直到页面出现真实查询或路由变化。

## 工程结构

| 路径 | 说明 |
| --- | --- |
| `entrypoints/` | 扩展源码：`popup/`、`options/`、`content/`、`background.ts` |
| `shared/` | 跨入口共享的代码：`settings.ts`（领域类型）、`settings-store.ts`（存储形状 → 渲染形状的唯一实现：源的收敛与分组条目解析）、`builtins.ts`（内置源目录与补源规则）、`defaults.ts`（默认配置）、`search-actions.ts`（特殊功能按钮定义）、`i18n.ts`（中英文案与 `t()`、静态 `data-i18n` 刷新）、`license.ts`（会员套餐与卡片数据、激活码编解码、分组与搜索源配额）、`license-api.ts`（与服务端通信、ES256 离线验签）、`features.ts`（已下线模块的开关）、`notes.ts`（笔记存储键与「存到第一行」的写入规则）、`outline.ts`（大纲纯模型层） |
| `public/` | 静态资源（图标等），构建时原样拷贝。工具栏图标由 `scripts/make-icons.py` 生成（透明底、单线放大镜，16/32/48/128 四档分别调描边） |
| `types/` | 补充类型声明 |
| `scripts/` | 工程脚本：`typecheck.mjs`（类型检查与类型债务度量）；`gen-license.mjs`（激活码生成与校验）；`gen-sync-fixture.cjs` / `read-sync-log.cjs`（同步基准的生成与取证）；`shoot-pinned.cjs`（常驻栏截图）；`shoot-options.cjs`（选项页逐页截图，可带标签与视口宽度做前后对比）；`make-pay-qrcode.py`（把微信导出的收款码 / 二维码原图裁成「关于」页用的小图）；`measure-render-perf.cjs`（常驻栏、顶栏图标排、大纲笔记与弹窗的渲染开销实测，见「渲染开销实测」） |
| `tests/` | 端到端回归用例与 `helpers.cjs`（加载真实构建产物跑浏览器） |
| `docs/` | 评审与设计存档。历史快照，其中的行号会随代码变动失效，不要当现状读 |
| `biome.json` | Lint 配置。只开零争议规则（未使用变量/导入、`==`、`useConst` 等），见「工程门禁」 |
| `.github/workflows/ci.yml` | CI：lint + 类型债务 → 构建 → 端到端回归 |
| `.output/` | 构建产物（忽略提交） |
| `output/` | 仅放本机产物：截图（`playwright/`、`shots/`）与 sync 存储快照，均不入库 |
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
| `npm run check` | 提交前门禁：`biome lint` + 类型债务不得超过基线 |
| `npm run lint` / `lint:fix` | 只跑 Lint / 跑 Lint 并自动修可修项 |
| `npm run test:e2e` | 端到端回归（**需先 `npm run build`**，测的是真实产物） |
| `npm run build:raw` | 直接调用 `wxt build`，见下方说明 |

## 端到端回归

用例在 `tests/`，加载 `.output/chrome-mv3` 真实产物跑 Chromium，覆盖类型检查与 Lint
都看不见的行为：浮层堆叠与 top layer 进出、常驻栏缓存失效、大纲拖拽与模型层边界、
笔记跨标签页同步、LLM 请求超时、触发图标在长选区/影子根下的稳定性、触发图标只认「屏幕上看得见的选区」
（离屏复制选区、选区被页面销毁、滚出视口都不出图标）、常驻栏首帧状态
（逐帧采样：打开网页时不得出现任何「展开帧」）、弹窗在「与自身无关的存储写入」下不重建
（以节点身份取证，不靠内容比对）、「iframe 里不注入」
这条边界，以及非 HTML 文档（XML 错误页、SVG）里不初始化、`text/plain` 页照常可用。

```
npm run build && npm run test:e2e          # 全部（默认并发，本机 20 个用例约 1.5 分钟）
npm run test:e2e -- top-layer              # 只跑文件名含该串的
npm run test:e2e -- --serial               # 串行（排查并发干扰时用）
QF_JOBS=6 npm run test:e2e                 # 指定并发数
QF_HEADED=1 npm run test:e2e               # 显示窗口（默认无头）
```

用例彼此独立（各自的临时 profile、各自的本地服务端口），所以 `tests/run.mjs` 默认按核数
并发（上限 4）：耗时从串行 300 秒降到 95 秒左右，单文件最长的那一个成为新的下限。
`--serial` 保留给「怀疑并发本身在干扰」的排查。用例内部也尽量等条件而不是等时间：
页面就位等宿主影子根里的产物出现（`waitExtensionReady`），导航等 URL/标签页真的变化
（`navWatch`），选项页等默认配置真的落盘。固定 sleep 只保留那些**断言本身**就是
「过一段时间之后仍然如此」的场景（例如常驻栏在 collapseDelay 之后才收起）。

依赖只用到 playwright，且**不写死路径**：`tests/helpers.cjs` 依次尝试项目依赖、
`QF_PW` 环境变量、`~/node_modules/playwright`，Chromium 用 playwright 自带的
（`QF_CHROME` 可覆盖）。所以换机或 CI 上装好 playwright 即可直接跑。

## 渲染开销实测

常驻搜索栏挂在 `scroll` / `resize` / `pointermove` / `MutationObserver` 上，属于「用户没碰插件也在付费」
的那类代码。它的开销不能靠读代码判断，所以有一个专门的实测脚本，加载真实产物跑 Chromium，
用内容脚本的同步派发耗时 + CDP 的 `LayoutCount` / `RecalcStyleCount` 同时量：

```
npm run build && node scripts/measure-render-perf.cjs
QF_LABEL=改前 node scripts/measure-render-perf.cjs    # 给同一次对比打标签
```

六档场景：合成滚动事件、合成 pointermove（收起态的把手热区判定）、图标排整批重建 N 轮、
页面持续变动时每 120ms 一次的挂载、大纲笔记搜索时的整表重渲染（300 行）、以及弹窗收到
「与自身无关的存储写入」时是否还整表重建。脚本头部写着量法上必须遵守的两条：**耗时取最小值**
（这台机器上一次测量能被后台负载抬高 2~3 倍），**计数取中位数**（它是确定的）。
改渲染路径前后各跑一次，用同一份脚本对比，别只报单次数字；其中 Layout / RecalcStyle
次数是最可信的那一列。

## 界面文案

设置页与插件的前端界面不放解释性文案：组件下面不写使用说明，不写「默认方式」「其余项目收起到更多菜单」
这类副标题，也不在段落里介绍这个页面能干什么。页面上只留三样——**控件名、控件、控件的当前状态**。
需要解释的内容写进 `title`（悬停可见），空态只描述状态（「还没有笔记项目」）而不写操作指引。

选项页的排版单位只有 `.row`：单行、标题左、控件右、行间一条分隔线；卡片是 `.rows`。互斥选项用
`.segmented`，布尔用 `.switch`，配置字段用 `.field`（标签定宽 + 输入框）。改动界面时不要新增
「一行标题 + 一行小字说明」的形态。

### 多语言

界面语言存在 sync 的 `language` 键（`'zh-CN' | 'en'`，缺省中文），三个入口读同一份。文案规则在
`shared/i18n.ts`：**中文源文案本身就是字典键**，`t('已保存')` 在英文下返回 `Saved`；漏译时回落到中文，
不会显示键名。带变量的句子写成 `t('已选 {n} 项', { n: 3 })`。静态 HTML 用 `data-i18n` /
`data-i18n-title` / `data-i18n-aria-label` / `data-i18n-placeholder` 打标，启动与切换语言后各调一次
`applyI18n(root)`；运行时拼出来的列表（分组标签、搜索源行、引擎按钮、历史卡片）必须整体重画，光靠
`data-i18n` 覆盖不到。内置源与特殊功能按钮的名字随语言变化，但只在「名字还是默认值」时翻译——
用户改过名的照原样显示，那是用户数据。新增文案时先写中文、再补 `EN` 里的一条，`tests/verify-language-2026-11-07.cjs`
会切到 English 逐页检查有没有漏掉的中文。

## 工程门禁

`npm run check` 一次覆盖两件事，CI 里先跑它、过了才构建与跑 e2e：

1. **Lint**（`biome.json`）：只开零争议规则——未使用变量/导入、`==`、`useConst`、
   `noUnreachable`、交换机贯穿。这些规则命中的都是「一定是笔误」的形态，不是风格偏好，
   因此不需要在改动里夹带格式化噪声。`entrypoints/**` 关掉 `noUnusedVariables`
   （迁移期仍有历史遗留），`noUnusedImports` 保持开启。
2. **类型债务**：超过 `.typecheck-baseline.json` 即失败，基线只允许下降。

需要改代码风格时再逐条开规则，不要在启用 Lint 的同一次改动里重排全文件。

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
- 三个入口仍是迁移前的 IIFE + `'use strict'` 写法，`popup/main.ts` 与 `options/main.ts`
  里多个函数曾挤在同一行（超长行已按语句边界拆过一轮，还剩 37 处，多是
  `renderNotes` 里单行构建 DOM + 模板字符串）。
- 可读性拆分（IIFE、单行挤多个函数）放在类型补齐之后单独做，两件事不要混在一次改动里。

