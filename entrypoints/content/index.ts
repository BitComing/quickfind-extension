// @ts-nocheck
// 由早期手写 JavaScript 迁移而来，尚未补齐类型标注；补全后删除本行。见 README「迁移状态」。
import { createNoteDrag } from '@/shared/note-drag';
import { LEGACY_NOTES_STORAGE_KEY, NOTES_STORAGE_KEY } from '@/shared/notes';
import { BUILTIN_SOURCES, DEFAULT_PINNED_SITE_IDS, PINNED_SITE_CONFIG_VERSION } from '@/shared/builtins';
import { DEFAULT_PINNED_SEARCH, DEFAULT_SETTINGS, MAX_DEFAULT_GROUP_COUNT } from '@/shared/defaults';
import { normalizeSearchConfig, resolveGroupEntries } from '@/shared/settings-store';
import { actionLabel, actionTooltip, applyI18n, countText, getLocale, groupLabel, normalizeLocale, setLocale, sourceLabel, t } from '@/shared/i18n';
import { decodeQueryText, normalizeSelectionText } from '@/shared/query-text';
import { markdownToPlainText, renderMarkdown } from '@/shared/markdown';
import { OUTLINE_NOTES_ENABLED, PAGE_SIDEBAR_ENABLED } from '@/shared/features';
import {
  createEmptyNotes as outlineCreateEmptyNotes,
  normalizeNotes as outlineNormalizeNotes,
  noteById as outlineNoteById,
  noteDepth as outlineNoteDepth,
  notePath as outlineNotePath,
  isNoteDescendant as outlineIsNoteDescendant,
  visibleNoteIds as outlineVisibleNoteIds,
  countMatches as outlineCountMatches,
  moveNote as outlineMoveNote,
  insertNoteAfter as outlineInsertNoteAfter,
  insertNoteChild as outlineInsertNoteChild,
  removeNote as outlineRemoveNote,
  changeNoteIndent as outlineChangeNoteIndent,
  mergeNoteWithPrevious as outlineMergeNoteWithPrevious,
  setAllNotesCollapsed as outlineSetAllNotesCollapsed,
} from '@/shared/outline';

export default defineContentScript({
  matches: ['<all_urls>'],
  // 只注入顶层文档，**任何子框架都不注入**。
  //
  // 早先这里是 allFrames + matchAboutBlank + matchOriginAsFallback，理由很直接：
  // 不注入子框架，iframe 里选中文字就没有触发图标。但同一条协议也把页面里那些
  // 并不需要扩展关照的小框架一并覆盖了——客服挂件、广告位、播放器、代码预览窗、
  // OAuth 弹层……它们同样是 iframe。在那些框架里选中文字，浮层会在框架内部弹出，
  // 还会被框架边界裁成很小一块，用户看到的就是「插件跑到小窗口里去了」。
  //
  // 想把「框架里选中、外层页面弹出」做成稳定能力是不行的：浮层按窗口视口定位，
  // 跨源框架既读不到父窗口尺寸，也无法把自己的位置换算到外层坐标系，只能靠猜。
  // 所以这里取一组确定的行为：扩展只作用于用户当前所在的这个网页本身，
  // 子框架里一律不出现——包括触发图标。
  allFrames: false,
  runAt: 'document_idle',
  main() {
  'use strict';

  /**
   * 非 HTML 文档一律不初始化。
   *
   * 直接打开 XML / SVG 时（对象存储的 AccessDenied 错误页就是最常见的例子：
   * https://static.deepseek.com/ 返回 `application/xml`，正文是一段 `<Error>`），
   * `document.createElement('div')` 造出来的是没有 HTML 接口的元素，`host.style` 是
   * undefined —— 下面那句 `host.style.cssText = ...` 会抛
   * `TypeError: Cannot set properties of undefined (setting 'cssText')`，整个内容脚本
   * 就地中止，控制台留一条未处理异常。
   *
   * 判据刻意用「造一个元素看它有没有 style」，而不是 `document.contentType`：
   * text/plain 页面的 MIME 也不是 text/html，但浏览器把它渲染成 HTML 文档，正文照样
   * 可选、浮层照样能用，按 MIME 判会把这些正常页面一并误杀。而这里试出来的判断
   * 恰好等于「这个文档里能不能放 HTML 元素」。这类 XML 页面没有可搜的正文，
   * 本来也不该有浮层，直接退出即可。
   */
  if (!document.createElement('div').style) return;

  /**
   * 一个对话窗口的运行时形状。
   *
   * 每个窗口自带会话、在飞标志与视图状态——这些**不能**放成模块级的单例：
   * 多窗口并存时，共享一份状态会让两个窗口互相改写标题、清空对方的输入框。
   * 只有「会话列表」与「配置」是全局的。
   */
  interface LlmChatWindow {
    root: HTMLElement;
    conversation: any;
    /** 几何记忆的键：会话 id（新对话落库前是个临时 draft 键）。 */
    geometryKey: string;
    requestInFlight: boolean;
    /** 当前视图：chat 显示对话流，history 显示会话列表。 */
    state: 'chat' | 'history';
    pinned: boolean;
    scroll: Element | null;
    historyList: Element | null;
    historyCount: Element | null;
    input: HTMLTextAreaElement | null;
    compose: HTMLElement | null;
    title: Element | null;
    subtitle: Element | null;
    back: HTMLElement | null;
    /** 独立的「历史会话」入口；与 back 分工：它进历史，back 退回来。 */
    historyButton: HTMLElement | null;
    pin: HTMLElement | null;
    jump: HTMLElement | null;
  }

  /**
   * 页面 shadow DOM 内选区的取回结果。
   *
   * 单独起一个名字是必要的：`found` 是个「闭包内被赋值、闭包外被读取」的变量，
   * 不标类型会被推断成 never（TS2339/TS7034），而这里必须显式写明它装了什么。
   */
  interface ShadowSelectionHit {
    text: string;
    range: Range;
    rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
  }

  // 站点目录只在选项页维护（它需要 url 与选择器用于编辑）。内容脚本只按
  // DEFAULT_PINNED_SITE_IDS 判断「当前页是不是内置搜索站点」，此前这里还留着一份
  // 只有 id+名字的副本，从未被引用——已删除。
  const LEGACY_PINNED_SITE_IDS = new Set(['google', 'bing', 'yandex', 'zhihu', 'bilibili']);
  const GENERIC_PINNED_INPUT_SELECTOR = 'input[type="search"], input[name="q"], input[name="query"], input[name="keyword"], input[name="text"], input[placeholder*="搜索"], input[placeholder*="Search"], textarea[name="q"]';

  // 内置源目录来自 shared/builtins.ts。这里统一用 url 模板形状（此前是 buildUrl 函数），
  // 与另两个入口一致，getSearchUrl 仍然两种都认。
  const ENGINES = BUILTIN_SOURCES;


  let settings = cloneSettings(DEFAULT_SETTINGS);
  let selectedText = '';
  // Range 对象，类型归属 DOM；本文件未补类型，显式 any 免得每个使用点各记一次隐式 any。
  let selectedRange: any = null;
  let selectedInput = null;
  let selectedInputStart = 0;
  let selectedInputEnd = 0;
  let anchorRect = null;
  let panelOpen = false;
  let expanded = false;
  let expandedGroupId = null;
  let panelManuallyMoved = false;
  let panelDragState = null;
  // 右键搜索源图标后弹出的「打开方式」菜单。同一时刻最多一个，记录元素与拆监听的回调。
  // root 记下它开在哪一套 shadow tree 里：常驻栏与选中文字浮层各有自己的收尾，
  // 收尾只该带走自己这一套里的菜单（见 closeOpenModeMenuIn）。
  let openModeMenu = null;
  // 显式 any：它初值是 null，不标注时 TypeScript 会把类型收成 null，之后每次读
// shadowRoot / classList 都要各记一条隐式 any；这里只把它当元素容器用。
  let pinnedHost: any = null;
  let pinnedExpandedGroupId = null;
  let pinnedMoreExpanded = false;
  // 常驻栏的静止态是「收起」。
  //
  // 初值必须是 true，不能是 false：内容脚本一启动就会挂着 window 上的 scroll / resize 监听
  // （refreshSelectionPosition → positionPinnedBar），而真实页面在加载期必然派发 scroll
  // （还原滚动位置、锚点、懒加载脚本），那一刻宿主若按「展开」建出来，用户就会先看到一条
  // 展开的空栏、再由 mountPinnedBar 收起——即报告的「打开网页时一刹那展开收起」。
  // 展开只能来自用户动作（划过把手 / 点把手），所以这里没有任何理由以展开为初值。
  let pinnedBarCollapsed = true;
  // 真实配置是否已从 storage 读回。
  //
  // settings 的初值是 DEFAULT_SETTINGS 的一份副本，它只是「还没读到用户配置」时的占位，
  // 不代表用户的真实意图。常驻栏的整套内容（站点、条目、启用开关）都来自 settings，
  // 因此在这面标志立起来之前一律不许挂载、不许显示：否则会先按默认配置画一遍
  // （画错站点、画到用户已关闭的页面上），再被真实配置改掉，同样是闪烁。
  let pinnedSettingsReady = false;
  let pinnedCollapseTimer = null;
  let pinnedCollapseDeadline = 0;
  let pinnedCollapsePaused = false;
  let pinnedQueryComposing = false;
  let pinnedMountTimer = null;
  let pinnedMountedSiteId = null;
  let pinnedMountedPageKey = '';
  // 由页面选区自动填入常驻搜索框的值，用于把它和「上一次搜索」的兜底值区分开。
  let pinnedSelectionQuery = '';
  // 用户在常驻搜索框里手打的内容。它和 pinnedSelectionQuery 是「用户留下的值」的两种来源，
  // 同一时刻最多只有一个非空。留着它是为了扛住重渲染：常驻栏任何一次重绘都会走
  // syncPinnedQuery 重新取值，没有这层记忆，失焦之后的输入会被历史兜底值直接冲掉。
  // 存原始值（不去空白），以便连光标前的尾随空格也一并还原。
  let pinnedDraftQuery = '';
  // 上次同步时页面的「真实查询」（页面搜索框的值或 URL 查询参数）。
  // 用它区分「页面真的换了查询」和「同一个查询下的重渲染」：前者要以页面为准、丢弃草稿，
  // 后者必须保留草稿，否则用户在结果页上改到一半的词会在重绘时被还原成原查询。
  let pinnedSyncedRealQuery = '';
  // 用户主动把常驻搜索框清空过。清空也是一种「用户留下的状态」，
  // 没有这个标记，下一次重渲染会把历史兜底值填回来，等于清空失效。
  let pinnedUserCleared = false;
  // 用户正在常驻栏上按住指针（按下但尚未抬起）。
  //
  // 自动收起的排定必须绕开这段窗口。原因：按钮会在「按下」与「抬起」之间被重渲染整体替换
  // （页面 DOM 一变就重建，动态页面可达每秒 6 次以上，见 renderPinnedBar）。替换会让宿主里
  // 那个已获得焦点的按钮离开文档，浏览器随即在 .bar 上派发 focusout——而收起排定正是挂在
  // focusout 上的，于是「点一下分组 → 1 秒后栏自己收起」。实测事件序列就是 focusin → focusout。
  let pinnedPointerHeld = false;
  // 指针最后停留的视口坐标。用于在「重渲染补发的 pointerleave / focusout」与「用户真的离开」
  // 之间做区分：前者坐标仍在栏的矩形内。采样放在 window 的 pointermove 上（那里已有监听）。
  let pinnedPointerX = -1;
  let pinnedPointerY = -1;
  // 上一次渲染常驻栏时的结构指纹。页面 DOM 一变就会走到 mountPinnedBar，没有这道闸，
  // 每次变动都会把按钮整批替换——动态页面上每秒六次以上（见 pinnedRenderSignatureFor）。
  let pinnedRenderSignature = '';
  // 刚由我们自己替换过节点；这段时间内 .bar 上的 focusout 是重渲染的副产物，不是用户移开焦点。
  // 用时间窗而不是一次性标志：focusout 是同步派发还是紧随其后的异步派发，各实现不一致。
  let pinnedFocusoutSuppressUntil = 0;
  // 常驻栏宿主的宽度——算横向位置时唯一需要的测量量。
  //
  // 为什么要缓存：滚动、页面变动（每 120ms 一次挂载）都会走到 positionPinnedBar，
  // 而它原先每次都读一次 barHost.offsetWidth。读它可能触发强制布局，代价随文档规模上涨，
  // 而宽度只取决于三件事：条目内容变了（renderPinnedBar 重建）、视口宽度变了（resize）、
  // 宿主从隐藏转可见（hidden 元素量出来恒为 0）。其余时候沿用上次结果，
  // 热路径上就只剩几个数字比较。
  let pinnedBarHostWidth = 0;
  let pinnedBarHostWidthDirty = true;
  // 常驻栏内容高度（写进 --pinned-bar-height 的值）。同理只在内容/展开态真的变了才重量：
  // 量它要读 .bar-content.scrollHeight，也是一次强制布局。
  let pinnedBarContentHeight = 0;
  let pinnedBarContentHeightDirty = true;
  // 已排队的「重新定位选中浮层/常驻栏」帧号，见 scheduleRefreshSelectionPosition。
  let refreshSelectionFrame = 0;
  let contextAnchor = null;
  let selectionPointer = null;
  let selectionPointerPending = false;
  let selectionPointerText = '';
  let mouseButtonDown = false;
  let selectionShowTimer = null;
  // 触发点显示期间巡检「选区还在不在」的计时器，见 selectionLooksGone / startSelectionWatch。
  let selectionWatchTimer: any = null;
  const LLM_CONVERSATIONS_KEY = 'quickfind-llm-conversations';
  /** LLM 请求超时上限，与 background 侧保持一致（那边也有同名常量，改一处要改两处）。 */
  const LLM_TIMEOUT_MS = 60000;
  let llmConversations = [];
  // 已打开的对话窗口。一个窗口对应一段会话（conversationId 为 null 表示「还没落库的新对话」）。
  // 允许多个并存，且每个窗口各自持有自己的请求在飞标志与渲染状态——共享一份状态会让
  // 两个窗口互相改写标题、清空对方输入框。
  const llmChatWindows: LlmChatWindow[] = [];
  // 新建窗口时用来错开位置的计数器，避免多个窗口叠在同一点。
  let llmWindowCascade = 0;
  // 窗口几何（位置/大小/置顶）的唯一存储键，随会话 id 记，跨刷新恢复。
  const LLM_WINDOW_GEOMETRY_KEY = 'quickfind-llm-window-geometry';
  /**
   * 与会话无关的「上次用过的尺寸」记忆键，存在同一张几何表里。
   *
   * 为什么需要它：几何按会话 id 记账，而「问 ai」每次都开一段**新对话**（draft-<时间戳>-<随机>），
   * 键每次都不同——用户拖好的大小永远命不中，新窗口一律回落到硬编码的 420×560，
   * 表现就是「尺寸记不住」。这里额外记一份全局尺寸，新窗口没有会话记忆时继承它。
   * 只记宽高、不记位置：位置按会话错开摆放是有意的（见 defaultLlmWindowRect）。
   */
  const LLM_WINDOW_SIZE_KEY = '__lastSize__';
  let llmCloseTimer = null;
  let llmDockOpen = false;
  // 用户主动点开过侧栏。区分「点击打开」与旧的「划过自动打开」：
  // 前者是明确意图，鼠标离开右边缘也不该被自动收起；后者已移除。
  // 关闭按钮、选项页关掉面板、切换页面都会清掉它。
  let llmDockPinnedOpen = false;
  let llmHistorySignature = '';
  let triggerHoverTimer = null;
  const TRIGGER_HOVER_OPEN_DELAY = 100;

  const host = document.createElement('div');
  host.id = 'quickfind-shadow-host';
  host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  // 单个宿主同时承载触发点、搜索面板和笔记侧栏（三者按类名各自显隐），所以用 manual 的
  // popover：由代码决定何时退出 top layer，而不是用户按 Esc 或点空白就被收走。
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      /* all:initial 会把 popover 的 UA 默认样式也一并重置，但浏览器此后可能再应用一次，
         这里显式压掉，避免宿主被拉成整屏、带上默认边框与 padding。 */
      :host([popover]) { position:fixed; inset:0; margin:0; padding:0; border:0; overflow:visible; background:transparent; max-width:none; max-height:none; }
      *, *::before, *::after { box-sizing: border-box; }
      .quickfind-trigger,
      .quickfind-panel { position: fixed; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .quickfind-trigger {
        display: grid;
        place-items: center;
        width: 25px;
        height: 25px;
        padding: 0;
        border: 0;
        border-radius: 7px;
        color: rgba(62,143,108,.88);
        background: transparent;
        box-shadow: none;
        cursor: pointer;
        opacity: 0;
        transform: translateX(-4px) scale(.94);
        transition: opacity .16s ease, transform .16s ease, background .16s ease, box-shadow .16s ease;
        pointer-events: auto;
      }
      .quickfind-trigger.visible { opacity: .9; transform: translateX(0) scale(1); }
      .quickfind-trigger.disabled { color:#a6b0aa; }
      .quickfind-trigger:hover { opacity: 1; color:#19352c; background:transparent; }
      .quickfind-trigger[aria-expanded="true"] { visibility:hidden; opacity:0; pointer-events:none; transform:translateX(-4px) scale(.94); }
      .quickfind-trigger:focus-visible, .engine:focus-visible { outline: 2px solid #3a8c6a; outline-offset: 2px; }
      .quickfind-trigger svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .quickfind-panel {
        width: max-content;
        max-width: calc(100vw - 20px);
        padding: 5px 7px 7px;
        border: 1px solid rgba(17,24,39,.08);
        border-radius: 11px;
        background: rgba(255, 255, 255, .96);
        box-shadow: 0 18px 45px rgba(17, 24, 39, .16), 0 2px 5px rgba(17, 24, 39, .06);
        backdrop-filter: blur(18px) saturate(1.1);
        -webkit-backdrop-filter: blur(18px) saturate(1.1);
        opacity: 0;
        transform: translateY(-5px);
        pointer-events: none;
        transition: opacity .16s ease, transform .16s ease;
      }
      .quickfind-panel.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .panel-drag-handle { display:grid; place-items:center; width:100%; height:9px; padding:0; border:0; color:#c3c7cf; background:transparent; cursor:grab; touch-action:none; }
      .panel-drag-handle::before { content:""; width:27px; height:3px; border-radius:99px; background:currentColor; }
      .panel-drag-handle:hover { color:#8a9099; }
      .panel-drag-handle:active, .quickfind-panel.dragging .panel-drag-handle { cursor:grabbing; }
      .panel-head { display:flex; flex-direction:column; align-items:stretch; min-width:0; margin-bottom:6px; }
      .query-row { position:relative; display:flex; align-items:center; min-width:180px; }
      .query-input { width:100%; height:28px; min-height:28px;
      max-height:116px; padding:3px 31px 3px 8px; overflow:hidden;
      resize:none; border:1px solid #d7d9df; border-radius:6px; outline:none; color:#17181c; background:#fff; font:11px/18px Inter,ui-sans-serif,sans-serif; }
      .query-input:focus { border-color:#2f795b; box-shadow:0 0 0 2px rgba(47,121,91,.12); }
      .query-row.expanded .query-input { padding-top:5px; padding-bottom:5px; overflow-y:auto; line-height:16px; }
      .query-expand { position:absolute; top:4px; right:4px;
      display:grid; place-items:center; width:20px; height:20px; padding:0; border:0; border-radius:5px; color:#8a9099; background:transparent; cursor:pointer; }
      .query-expand:hover, .query-expand[aria-expanded="true"] { color:#2f795b; background:#f1f2f4; }
      .query-expand:focus-visible { outline:2px solid #2f795b; outline-offset:2px; }
      .query-expand svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .engine-list { display:flex; align-items:center; flex-wrap:nowrap; gap:4px; width:max-content; max-width:100%; overflow-x:auto; }
      /* 「更多」展开的菜单：与常驻搜索栏的更多飞层同一套外观——浮在面板外的
         一张白卡（同样的圆角、描边、投影与背景模糊），行距也压到同一档。
         此前它是面板里的一段内联列表：展开后整块面板被撑高、下面多一条分隔线，
         同一功能在常驻栏与选区工具栏长得完全两样。 */
      .hidden-engine-list, .group-engine-list {
        position:absolute; z-index:2;
        display:flex; flex-direction:column; align-items:stretch; gap:4px;
        width:170px; max-width:calc(100vw - 20px); max-height:calc(100vh - 20px);
        padding:4px; overflow-y:auto;
        border:1px solid rgba(17,24,39,.1); border-radius:7px;
        background:rgba(255,255,255,.98);
        box-shadow:0 12px 30px rgba(17,24,39,.16),0 2px 5px rgba(17,24,39,.06);
        backdrop-filter:blur(14px) saturate(1.1); -webkit-backdrop-filter:blur(14px) saturate(1.1);
        pointer-events:auto;
      }
      .hidden-engine-list[hidden], .group-engine-list[hidden] { display:none; }
      .hidden-engine-list .engine, .group-engine-list .engine {
        width:100%; min-height:23px; justify-content:flex-start; gap:4px;
        padding:2px 6px 2px 3px; border-color:#d7d9df; border-radius:5px;
        font:600 11px/1.2 Inter,ui-sans-serif,sans-serif;
        transition:border-color .14s ease,background .14s ease;
      }
      .hidden-engine-list .engine:hover, .group-engine-list .engine:hover { border-color:#c9ccd2; background:#f6f7f8; transform:none; box-shadow:none; }
      .hidden-engine-list .engine:focus-visible, .group-engine-list .engine:focus-visible { outline:2px solid #2f795b; outline-offset:2px; }
      .hidden-engine-list .engine .engine-mark, .group-engine-list .engine .engine-mark { width:17px; height:17px; border-radius:4px; font-size:10px; }
      .hidden-engine-list .engine .engine-name, .group-engine-list .engine .engine-name { max-width:94px; font-size:11px; }
      /* 分组飞层与「更多」菜单共用上面这套卡面：从「更多」里点分组时，
         菜单原地换成该分组的内容，不会突然变小的同时把行撑高。 */
      .engine { display:flex; flex:0 0 auto; min-width:0; flex-direction:row;
      align-items:center; gap:4px; padding:4px 6px 4px 4px;
      border:1px solid #e1e2e6; border-radius:7px; color:#33363d;
      background:#fff; cursor:pointer; transition: border-color .14s ease, background .14s ease, transform .14s ease, box-shadow .14s ease; }
      .engine:hover { border-color:#c9ccd2; background:#f6f7f8; transform:translateY(-1px); box-shadow:0 4px 10px rgba(17, 24, 39, .08); }
      .engine:active { transform:translateY(0); }
      .engine-mark { display:grid; place-items:center; width:19px; height:19px; overflow:hidden; border-radius:5px; font:700 11px/1 Arial, sans-serif; }
      .engine-mark img { width:100%; height:100%; object-fit:cover; }
      .engine-name { overflow:hidden; max-width:64px; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:600; }
      .engine.icon-only { padding-right:4px; }
      .engine.icon-only .engine-name { display:none; }
      .engine.group-text-only { padding:5px 8px; }
      .engine.group-text-only .engine-name { max-width:100px; }
      .google .engine-mark { color:#fff; background:#4285f4; }
      .baidu .engine-mark { color:#fff; background:#2932e1; }
      .google-scholar .engine-mark { color:#fff; background:#5f6368; font-size:9px; }
      .duckduckgo .engine-mark { color:#fff; background:#de5833; }
      .so .engine-mark { color:#fff; background:#19a15f; font-size:9px; }
      .sogou .engine-mark { color:#fff; background:#ff5a34; }
      .bing .engine-mark { color:#fff; background:#1185e0; }
      .yandex .engine-mark { color:#fff; background:#ef3b3b; }
      .google-ai .engine-mark { color:#fff; background:#6b5ce7; font-size:9px; }
      .bilibili .engine-mark { color:#fff; background:#00aeec; }
      .xiaohongshu .engine-mark { color:#fff; background:#ef4d62; }
      .x .engine-mark { color:#fff; background:#111; }
      .youtube .engine-mark { color:#fff; background:#f21f26; }
      .zhihu .engine-mark { color:#fff; background:#1777e6; }
      .douyin .engine-mark { color:#fff; background:#161823; }
      .doubao .engine-mark { color:#fff; background:#4f7cff; }
      .deepseek .engine-mark { color:#fff; background:#4d6bfe; font-size:9px; }
      .special-copy .engine-mark { color:#fff; background:#6b7280; }
      .special-notes .engine-mark { color:#fff; background:#3e8f6c; }
      .special-ask-ai .engine-mark { color:#f5c56b; background:#19352c; font-size:9px; }
      .custom .engine-mark { color:#4b5563; background:#f1f2f4; }
      .more-engine .engine-mark { color:#4b5563; background:#f1f2f4; font-size:13px; }
      .group .engine-mark { color:#4b5563; background:#f1f2f4; font-size:12px; }
      /* 右键搜索源图标后的打开方式菜单：白底浮层，两项互斥，选完即关。 */
      .qf-open-menu { position:fixed; z-index:2147483647; display:flex; flex-direction:column; min-width:118px; padding:4px;
      border:1px solid rgba(17,24,39,.1); border-radius:8px; background:rgba(255,255,255,.98);
      box-shadow:0 12px 30px rgba(17,24,39,.16),0 2px 5px rgba(17,24,39,.06);
      backdrop-filter:blur(14px) saturate(1.1); -webkit-backdrop-filter:blur(14px) saturate(1.1);
      font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; pointer-events:auto; }
      .qf-open-menu-item { display:flex; align-items:center; width:100%; min-height:26px; padding:0 8px; border:0; border-radius:5px;
      color:#33363d; background:transparent; font:600 11px/1.2 Inter,ui-sans-serif,sans-serif; text-align:left; white-space:nowrap; cursor:pointer; }
      .qf-open-menu-item:hover { color:#17181c; background:#f1f2f4; }
      .qf-open-menu-item:focus-visible { outline:2px solid #2f795b; outline-offset:-2px; }
      .llm-dock { position:fixed; inset:0; z-index:2147483646;
      width:100vw; height:100vh; pointer-events:none; font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#203b31; }
      .llm-dock[hidden] { display:none; }
      /* 「问 ai」弹出的对话层独立于右侧栏：选项页关掉「随心问」面板时，宿主仍要能承载
         对话面板，只是不显示滑杆与侧栏。宿主显隐由 syncLlmDockHostVisibility 统一决定。 */
      .llm-dock.is-chat-only .llm-rail,
      .llm-dock.is-chat-only .llm-sidebar { display:none; }
      .llm-rail { position:fixed; top:50%; right:0; display:flex;
      align-items:center; justify-content:center; width:14px;
      height:20vh; min-height:96px; max-height:176px; padding:0;
      border:0; border-left:1px solid #e4eee8; border-radius:9px 0 0 9px;
      transform:translateY(-50%); color:#6a8978; background:#fff;
      box-shadow:-4px 0 14px rgba(24,61,44,.08); cursor:pointer; pointer-events:auto; transition:width .22s ease, color .18s ease, box-shadow .22s ease; }
      .llm-rail::before { content:""; width:3px; height:44px; border-radius:99px; background:currentColor; opacity:.55; transition:height .18s ease,opacity .18s ease; }
      .llm-rail:hover,.llm-dock.is-open .llm-rail { width:16px; color:#2f795b; box-shadow:-6px 0 18px rgba(24,61,44,.13); }
      .llm-rail:hover::before,.llm-dock.is-open .llm-rail::before { height:68px; opacity:.8; }
      .llm-sidebar { position:fixed; top:0; right:0; display:flex;
      flex-direction:column; width:min(392px,calc(100vw - 24px));
      height:100vh; overflow:hidden; border-left:1px solid #dce9e1;
      background:#fff; box-shadow:-18px 0 46px rgba(25,57,42,.15); pointer-events:auto; transform:translateX(102%); transition:transform .28s cubic-bezier(.2,.8,.2,1); }
      .llm-dock.is-open .llm-sidebar { transform:translateX(0); }
      .llm-sidebar-head { display:flex; align-items:center; gap:10px; min-height:74px; padding:17px 18px 12px; border-bottom:1px solid #f1f2f4; }
      .llm-brand-mark { display:grid; place-items:center; width:34px; height:34px; flex:0 0 auto; border-radius:10px; color:#f5c56b; background:#17181c; }
      .llm-brand-mark svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-kicker { color:#779286; font-size:9px; font-weight:750; letter-spacing:.13em; }
      .llm-title { margin-top:2px; color:#17181c; font-size:18px; font-weight:730; line-height:1.2; }
      .llm-sidebar-close { display:grid; place-items:center; width:28px; height:28px; margin-left:auto; padding:0; border:0; border-radius:6px; color:#6b7280; background:transparent; cursor:pointer; }
      .llm-sidebar-close:hover { color:#17181c; background:#f1f2f4; }
      .llm-sidebar-close svg,.llm-new-chat svg,.llm-chat-icon svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-status-row { display:flex; align-items:center; gap:7px; min-height:38px; padding:0 18px; color:#73867c; font-size:10px; }
      .llm-status-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#d6a05b; box-shadow:0 0 0 3px #fff6e9; }
      .llm-status-dot.ready { background:#3e9a6e; box-shadow:0 0 0 3px #e9f7ee; }
      .llm-status-dot.busy { background:#4f7cff; box-shadow:0 0 0 3px #edf0ff; animation:quickfind-llm-pulse 1.2s ease-in-out infinite; }
      .llm-status-dot.error { background:#c76a5f; box-shadow:0 0 0 3px #fcecea; }
      .llm-status-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-new-chat { display:inline-flex; align-items:center;
      gap:4px; min-height:25px; margin-left:auto; padding:0 7px; border:1px solid #d7d9df; border-radius:6px; color:#3c6d58; background:#fff; font-size:10px; cursor:pointer; }
      .llm-new-chat:hover { border-color:#2f795b; background:#f6f7f8; }
      .llm-history-wrap { min-height:0; flex:1; padding:8px 15px 14px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#d4d7dc transparent; }
      .llm-history-heading { display:flex; align-items:center; justify-content:space-between; padding:5px 3px 9px; color:#6b7280; font-size:11px; font-weight:700; }
      .llm-history-count { color:#9aa1ab; font-size:10px; font-weight:500; }
      .llm-history-list { display:flex; flex-direction:column; gap:8px; }
      /* 卡片是 div 而不是 button：里面要放删除按钮，而 button 不能嵌套 button
         （浏览器会把它拆开，删除按钮就点不到）。交互语义用 role/tabindex 补。 */
      .llm-history-card { display:flex; align-items:flex-start; gap:4px; width:100%; min-height:78px;
      padding:12px 9px 12px 13px; border:1px solid #e7e8ec; border-radius:8px;
      color:#33363d; background:#fafafa; text-align:left; cursor:pointer; transition:border-color .14s ease,background .14s ease,box-shadow .14s ease,transform .14s ease; }
      .llm-history-card:hover { border-color:#c9ccd2; background:#f6f7f8; box-shadow:0 6px 16px rgba(17,24,39,.06); transform:translateY(-1px); }
      .llm-history-card:focus-visible { outline:2px solid #2f795b; outline-offset:2px; }
      .llm-card-body { min-width:0; flex:1; }
      /* 删除按钮默认收敛，指针进入卡片或按钮获得键盘焦点时才显形：
         常驻显示会让整列卡片看起来像一堆危险操作。
         ⚠️ opacity:0 的元素**照样接收指针事件**——不关掉 pointer-events 的话，
         点卡片右上角会落到这个看不见的按钮上（表现为「点卡片没打开对话，反而在问要不要删」）。
         pointer-events 不影响键盘可达性，Tab 仍能聚焦到它。 */
      .llm-card-delete { display:grid; place-items:center; width:24px; height:24px; flex:0 0 auto; padding:0;
      border:0; border-radius:6px; color:#9aa1ab; background:transparent; cursor:pointer; opacity:0; pointer-events:none; transition:opacity .14s ease,color .14s ease,background .14s ease; }
      .llm-history-card:hover .llm-card-delete,.llm-card-delete:focus-visible { opacity:1; pointer-events:auto; }
      .llm-card-delete:hover { color:#b65c4f; background:#fff0ed; }
      .llm-card-delete svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
      /* 两步确认：第一下只「上膛」，再点一下才真删。不可逆的删除不该一次点击就完成，
         而在 shadow DOM 里弹原生 confirm 会被部分页面拦掉，所以用按钮自身表达。 */
      .llm-card-delete.is-armed { width:auto; padding:0 7px; opacity:1; color:#fff; background:#b65c4f; font-size:9px; font-weight:700; white-space:nowrap; }
      .llm-card-delete.is-armed:hover { background:#9d4a3f; }
      .llm-card-title { display:block; overflow:hidden; color:#17181c; font-size:12px; font-weight:680; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
      .llm-card-preview { display:-webkit-box; margin-top:6px; overflow:hidden; color:#9aa1ab; font-size:10px; line-height:1.5; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
      .llm-card-meta { display:flex; align-items:center; justify-content:space-between; margin-top:8px; color:#9aa1ab; font-size:9px; }
      .llm-history-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:240px; padding:24px 25px; color:#9aa1ab; text-align:center; }
      .llm-history-empty[hidden] { display:none; }
      .llm-history-empty svg { width:32px; height:32px; margin-bottom:10px; fill:none; stroke:#9aa1ab; stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; }
      .llm-history-empty strong { color:#6b7280; font-size:12px; font-weight:680; }
      .llm-history-empty span { max-width:220px; margin-top:6px; font-size:10px; line-height:1.6; }
      .llm-compose { margin:0; padding:11px 15px 15px; border-top:1px solid #e6efe9; background:#fff; }
      .llm-compose-box { position:relative; border:1px solid #d7d9df; border-radius:8px; background:#fafafa; transition:border-color .14s ease,box-shadow .14s ease; }
      .llm-compose-box:focus-within { border-color:#2f795b; box-shadow:0 0 0 3px rgba(47,121,91,.12); }
      .llm-compose textarea,.llm-chat-compose textarea { display:block;
      width:100%; min-height:52px; max-height:128px; padding:10px 12px 5px;
      border:0; outline:none; resize:none; overflow-y:auto; color:#33363d; background:transparent; font:12px/1.55 Inter,ui-sans-serif,sans-serif; }
      .llm-compose textarea::placeholder,.llm-chat-compose textarea::placeholder { color:#9aa1ab; }
      .llm-compose-bottom { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 7px 7px 12px; }
      .llm-compose-hint { color:#9aa1ab; font-size:9px; }
      .llm-send { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:7px; color:#fff; background:#2f795b; cursor:pointer; }
      .llm-send:hover { background:#25654b; }
      .llm-send:disabled { opacity:.45; cursor:not-allowed; }
      .llm-send svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-send:focus-visible,.llm-chat-close:focus-visible,.llm-chat-back:focus-visible,.llm-chat-pin:focus-visible,.llm-chat-history-btn:focus-visible,.llm-card-delete:focus-visible,.llm-rail:focus-visible,.llm-sidebar-close:focus-visible { outline:2px solid #2f795b; outline-offset:2px; }
      .llm-tabbar { display:flex; gap:3px; flex:0 0 auto; margin:0 15px 8px; padding:3px; border-radius:10px; background:#f1f2f4; }
      .llm-tab { display:flex; flex:1; align-items:center; justify-content:center;
      min-width:0; min-height:29px; padding:0 8px; overflow:hidden;
      border:0; border-radius:8px; color:#6b7280; background:transparent;
      font-size:11px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; transition:color .15s ease, background .15s ease, box-shadow .15s ease; }
      .llm-tab:hover { color:#2f795b; }
      .llm-tab.is-active { color:#17181c; background:#fff; box-shadow:0 1px 4px rgba(17,24,39,.08); }
      .llm-tab:focus-visible { outline:2px solid #2f795b; outline-offset:1px; }
      .llm-pane { display:flex; flex:1; flex-direction:column; min-height:0; }
      .llm-pane[hidden] { display:none; }
      .outline-toolbar { display:flex; align-items:center; gap:5px; flex:0 0 auto; padding:0 15px 7px; }
      .outline-search { display:flex; align-items:center; gap:4px; flex:1; min-width:0; height:28px; padding:0 7px; border:1px solid #dbe8e0; border-radius:7px; background:#fff; }
      .outline-search:focus-within { border-color:#2f795b; }
      .outline-search svg { width:11px; height:11px; flex:0 0 auto; fill:none; stroke:#8fa298; stroke-width:2; stroke-linecap:round; }
      .outline-search input { min-width:0; flex:1; border:0; padding:0; outline:none; color:#33363d; background:transparent; font:11px Inter,ui-sans-serif,sans-serif; }
      .outline-tool-button { display:inline-flex; align-items:center;
      justify-content:center; gap:3px; min-height:28px; flex:0 0 auto;
      padding:0 8px; border:1px solid #d7d9df; border-radius:7px; color:#3c6d58; background:#fff; font-size:10px; font-weight:650; white-space:nowrap; cursor:pointer; }
      .outline-tool-button:hover { border-color:#2f795b; background:#f6f7f8; }
      .outline-tool-button:disabled { opacity:.45; cursor:not-allowed; }
      .outline-tool-button:focus-visible { outline:2px solid #2f795b; outline-offset:1px; }
      .outline-tool-button svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
      .outline-tool-icon { width:28px; padding:0; }
      .outline-context { display:flex; align-items:center; gap:5px; flex:0 0 auto; padding:0 15px 6px; }
      .outline-home { flex:0 0 auto; padding:3px 8px; border:1px solid #d7d9df;
      border-radius:6px; color:#3c6d58; background:#fff; font-size:10px; font-weight:650; white-space:nowrap; cursor:pointer; }
      .outline-home:hover { border-color:#2f795b; background:#f6f7f8; }
      .outline-context-separator { color:#b6c6bc; }
      .outline-breadcrumb { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#4b6157; font-size:10px; }
      .outline-search-result { flex:0 0 auto; color:#8fa298; font-size:10px; }
      .outline-scroll { flex:1; min-height:0; padding:4px 10px 14px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#d4d7dc transparent; }
      .outline-list { position:relative; }
      .notes-zoom-heading { padding:2px 6px 8px; color:#4b6157; font-size:11px; font-weight:700; }
      .notes-empty { padding:26px 10px; color:#91a199; font-size:11px; line-height:1.7; text-align:center; }
      .note-row { display:flex; align-items:flex-start; gap:3px; padding:1px 4px; border-radius:6px; transition:background .12s ease; }
      .note-row:hover,.note-row:focus-within { background:#f4faf6; }
      .note-row.dragging { opacity:.4; }
      .note-row.drag-target-before { box-shadow:inset 0 2px 0 #2f795b; }
      .note-row.drag-target-inside { box-shadow:inset 0 0 0 2px #2f795b; }
      .note-row.drag-target-after { box-shadow:inset 0 -2px 0 #2f795b; }
      .note-toggle { display:grid; place-items:center; width:16px; height:22px; flex:0 0 auto; padding:0; border:0; border-radius:4px; color:#93a79c; background:transparent; cursor:pointer; }
      .note-toggle:hover:not(:disabled) { color:#2f795b; background:#eef7f1; }
      .note-toggle:disabled { opacity:.35; cursor:default; }
      .note-toggle svg { width:10px; height:10px; fill:none; stroke:currentColor; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; transition:transform .15s ease; }
      .note-toggle.collapsed svg { transform:rotate(-90deg); }
      .note-complete { display:grid; place-items:center; width:17px; height:22px; flex:0 0 auto; padding:0; border:0; color:#93a79c; background:transparent; cursor:pointer; }
      .note-complete:hover { color:#2f795b; }
      .note-complete svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
      .note-row.completed .note-input { color:#9aa1ab; text-decoration:line-through; }
      .note-bullet { display:grid; place-items:center; width:15px;
      height:22px; flex:0 0 auto; padding:0; border:0; border-radius:4px; background:transparent; cursor:pointer; touch-action:none; -webkit-user-select:none; user-select:none; }
      .note-bullet::before { content:""; width:5px; height:5px; border-radius:50%; background:#b9cbc0; transition:width .12s ease,height .12s ease,background .12s ease,box-shadow .12s ease; }
      .note-bullet:hover::before { width:9px; height:9px; background:#fff; box-shadow:inset 0 0 0 1.4px #9bbfaa; }
      .note-bullet.is-armed::before { width:11px; height:11px; background:#f6f7f8; box-shadow:inset 0 0 0 1.4px #2f795b; }
      .note-bullet:focus-visible { outline:2px solid #2f795b; outline-offset:1px; }
      .note-input { min-width:0; flex:1; padding:2px 4px; border:1px solid transparent;
      border-radius:6px; outline:none; resize:none; overflow:hidden; color:#2c4b3d; background:transparent; font:12px/1.6 Inter,ui-sans-serif,sans-serif; cursor:text; }
      .note-row.search-match .note-input { background:#f6f7f8; }
      .outline-list.is-dragging { -webkit-user-select:none; user-select:none; cursor:grabbing; }
      .note-drag-ghost { position:fixed; z-index:2147483647;
      max-width:240px; padding:2px 7px; overflow:hidden; border-radius:6px;
      color:#2c4b3d; background:#fff; box-shadow:0 8px 22px rgba(17,43,31,.2),0 1px 3px rgba(17,43,31,.1);
      font:12px/1.6 Inter,ui-sans-serif,sans-serif; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; }
      /* 对话窗口容器：只做定位与层叠，**不加蒙版**——页面照常可见可点，窗口之间也不互相遮挡视角。
         容器本身不接收指针事件，事件由各个窗口自己的矩形接住，这样空处能直接穿透给页面。 */
      .llm-chat-layer { position:fixed; inset:0; z-index:3; pointer-events:none; }
      .llm-chat-layer[hidden] { display:none; }
      .llm-chat-dialog { position:absolute; display:flex; flex-direction:column;
      width:420px; height:min(560px,calc(100vh - 32px)); min-width:280px; min-height:240px;
      overflow:hidden; border:1px solid #e7e8ec; border-radius:10px;
      background:#fff; box-shadow:0 24px 65px rgba(17,24,39,.22),0 3px 10px rgba(17,24,39,.06);
      pointer-events:auto; }
      /* 入场动画是**一次性**的：只在建窗口时挂 .is-entering，animationend 后摘掉。
         千万别把它写在 .llm-chat-dialog 的基础规则上——那样它在整个生命周期里都挂着，
         每次增删别的类（如拖动时的 is-dragging）都会让浏览器把动画**从头重放一遍**：
         opacity 归 0 + translateY(8px)，表现为「每次拖完窗口都闪一下、跳一下」。 */
      .llm-chat-dialog.is-entering { animation:quickfind-llm-rise .22s cubic-bezier(.2,.8,.2,1); }
      /* 置顶窗口：抬到同层其它窗口之上，并用描边把「已置顶」画出来。 */
      .llm-chat-dialog.is-pinned { z-index:5; border-color:#c9ccd2; box-shadow:0 26px 70px rgba(17,24,39,.26),0 0 0 2px rgba(23,24,28,.12); }
      .llm-chat-dialog.is-dragging { transition:none; }
      .llm-chat-dialog.is-resizing { transition:none; }
      .llm-chat-head { display:flex; align-items:center; gap:8px; min-height:61px; padding:11px 13px; border-bottom:1px solid #f1f2f4;
      cursor:grab; touch-action:none; -webkit-user-select:none; user-select:none; }
      .llm-chat-dialog.is-dragging .llm-chat-head { cursor:grabbing; }
      /* 头部按钮统一外观。返回键只在历史视图里出现（用 [hidden] 收起），
         所以它不再兼作「查看历史」的入口——历史是独立的 .llm-chat-history-btn。 */
      .llm-chat-back,.llm-chat-close,.llm-chat-pin,.llm-chat-history-btn { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; color:#6b7280; background:transparent; cursor:pointer; }
      .llm-chat-back[hidden],.llm-chat-history-btn[hidden] { display:none; }
      /* 头部按钮里的 svg 必须给尺寸与描边：不给的话 svg 用自身默认的 300×150 横铺，
         被 28×28 的按钮裁掉一角，图标就成了一条看不清的糊线。 */
      .llm-chat-back svg,.llm-chat-close svg,.llm-chat-pin svg,.llm-chat-history-btn svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-chat-back:hover,.llm-chat-close:hover,.llm-chat-pin:hover,.llm-chat-history-btn:hover { color:#17181c; background:#f1f2f4; }
      .llm-chat-history-btn.is-active { color:#2f795b; background:#e7e8ec; }
      .llm-chat-pin.is-active { color:#2f795b; background:#e7e8ec; }
      .llm-chat-head-copy { min-width:0; flex:1; }
      .llm-chat-head-copy[title] { cursor:grab; }
      .llm-chat-dialog.is-dragging .llm-chat-head-copy[title] { cursor:grabbing; }
      .llm-chat-icon { display:grid; place-items:center; width:29px; height:29px; border-radius:8px; color:#f5c56b; background:#17181c; flex:0 0 auto; }
      .llm-chat-title { overflow:hidden; color:#17181c; font-size:12px; font-weight:720; text-overflow:ellipsis; white-space:nowrap; }
      .llm-chat-subtitle { margin-top:3px; color:#9aa1ab; font-size:9px; }
      /* 缩小/放大：右下角抓手。 */
      .llm-chat-resize { position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize; touch-action:none; }
      .llm-chat-resize::before { content:""; position:absolute; right:3px; bottom:3px; width:7px; height:7px;
      border-right:2px solid #c9ccd2; border-bottom:2px solid #c9ccd2; border-radius:0 0 2px 0; }
      .llm-chat-scroll .llm-md > :first-child { margin-top:0; }
      .llm-chat-scroll .llm-md > :last-child { margin-bottom:0; }
      .llm-chat-scroll .llm-md p { margin:0 0 8px; }
      .llm-chat-scroll .llm-md h1,.llm-chat-scroll .llm-md h2,.llm-chat-scroll .llm-md h3,
      .llm-chat-scroll .llm-md h4,.llm-chat-scroll .llm-md h5,.llm-chat-scroll .llm-md h6 { margin:12px 0 6px; color:#17181c; font-weight:720; line-height:1.35; }
      .llm-chat-scroll .llm-md h1 { font-size:16px; } .llm-chat-scroll .llm-md h2 { font-size:15px; }
      .llm-chat-scroll .llm-md h3 { font-size:13px; } .llm-chat-scroll .llm-md h4,
      .llm-chat-scroll .llm-md h5,.llm-chat-scroll .llm-md h6 { font-size:12px; }
      .llm-chat-scroll .llm-md ul,.llm-chat-scroll .llm-md ol { margin:0 0 8px; padding-left:19px; }
      .llm-chat-scroll .llm-md li { margin:3px 0; }
      .llm-chat-scroll .llm-md code { padding:1px 4px; border-radius:4px; background:#f1f2f4; font:11px/1.5 "SFMono-Regular",Consolas,"Liberation Mono",monospace; }
      .llm-chat-scroll .llm-md pre { margin:0 0 8px; padding:9px 11px; overflow-x:auto; border:1px solid #e7e8ec;
      border-radius:7px; background:#fafafa; }
      .llm-chat-scroll .llm-md pre code { padding:0; background:transparent; white-space:pre; }
      .llm-chat-scroll .llm-md blockquote { margin:0 0 8px; padding:2px 0 2px 10px; border-left:3px solid #e7e8ec; color:#6b7280; }
      .llm-chat-scroll .llm-md a { color:#2f795b; text-decoration:underline; text-underline-offset:2px; }
      .llm-chat-scroll .llm-md hr { margin:10px 0; border:0; border-top:1px solid #e7e8ec; }
      .llm-chat-scroll .llm-md strong { color:#17181c; font-weight:720; }
      /* 「回到底部」：新回复到达时若用户正往上翻，不强行拽走视线。 */
      .llm-chat-jump { position:absolute; right:16px; bottom:110px; display:grid; place-items:center; width:30px; height:30px;
      padding:0; border:1px solid #e7e8ec; border-radius:50%; color:#6b7280; background:#fff; cursor:pointer;
      box-shadow:0 6px 16px rgba(17,24,39,.1); pointer-events:auto; }
      .llm-chat-jump[hidden] { display:none; }
      .llm-chat-jump:hover { background:#f6f7f8; }
      .llm-chat-jump svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; }
      .llm-chat-scroll { display:flex; flex:1; flex-direction:column; gap:14px; padding:18px 15px; overflow-y:auto; background:#ffffff; scrollbar-width:thin; scrollbar-color:#d4d7dc transparent; }
      /* 类选择器上的 display 会压过 UA 的 [hidden]{display:none}（作者样式恒胜 UA 样式），
         不显式兜底的话 hidden 形同虚设——切到历史视图时对话流会与列表同时显示。 */
      .llm-chat-scroll[hidden],.llm-chat-compose[hidden] { display:none; }
      /* 窗口内的历史视图：与对话流互斥显示，复用同一片区域。 */
      .llm-chat-history { flex:1; min-height:0; padding:10px 12px 14px; overflow-y:auto; background:#ffffff; scrollbar-width:thin; scrollbar-color:#d4d7dc transparent; }
      .llm-chat-history[hidden] { display:none; }
      .llm-chat-history-head { display:flex; align-items:center; justify-content:space-between; padding:4px 3px 9px; color:#6b7280; font-size:11px; font-weight:700; }
      .llm-chat-history-count { color:#9aa1ab; font-size:10px; font-weight:500; }
      .llm-chat-history-list { display:flex; flex-direction:column; gap:8px; }
      .llm-chat-history-empty { display:flex; align-items:center; justify-content:center; min-height:200px; padding:20px; color:#9aa1ab; text-align:center; font-size:10px; line-height:1.6; }
      .llm-message { display:flex; flex-direction:column; max-width:88%; gap:5px; }
      .llm-message.user { align-self:flex-end; align-items:flex-end; }
      .llm-message.assistant { align-self:flex-start; align-items:flex-start; }
      .llm-message-label { color:#9aa1ab; font-size:9px; font-weight:650; }
      .llm-message-bubble { padding:10px 12px; border:1px solid #e7e8ec;
      border-radius:9px; color:#33363d; background:#fff; font-size:12px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; }
      /* 助手气泡里是渲染后的 Markdown，块级元素自带间距，外层不再整体 pre-wrap。 */
      .llm-message.assistant .llm-message-bubble { white-space:normal; }
      .llm-message.user .llm-message-bubble { border-color:#e7e8ec; color:#17181c; background:#f1f2f4; border-bottom-right-radius:3px; }
      .llm-message.assistant .llm-message-bubble { border-bottom-left-radius:3px; }
      .llm-message.pending .llm-message-bubble { color:#9aa1ab; }
      .llm-typing { display:inline-flex; align-items:center; gap:3px; height:14px; }
      .llm-typing i { width:4px; height:4px; border-radius:50%; background:#9aa1ab; animation:quickfind-llm-dot 1s ease-in-out infinite; }
      .llm-typing i:nth-child(2) { animation-delay:.15s; }.llm-typing i:nth-child(3) { animation-delay:.3s; }
      .llm-chat-compose { padding:10px 12px 12px; border-top:1px solid #f1f2f4; background:#fff; }
      .llm-chat-compose .llm-compose-box { background:#fafafa; }
      .llm-chat-compose .llm-compose-bottom { padding-bottom:6px; }
      .llm-chat-footer-note { padding:0 4px 7px; color:#9aa1ab; font-size:9px; }
      @keyframes quickfind-llm-pulse { 0%,100%{opacity:.55}50%{opacity:1} }
      @keyframes quickfind-llm-rise { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes quickfind-llm-dot { 0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)} }
      @media (prefers-reduced-motion: reduce) { .quickfind-trigger, .quickfind-panel, .engine, .llm-rail,.llm-sidebar,.llm-history-card,.llm-chat-dialog { transition:none;
      animation:none; } .llm-status-dot.busy,.llm-typing i { animation:none; } }
      /* 窄屏下窗口不再留边距——它本来就可拖可缩，不强行吸附到整屏。 */
      @media (max-width:600px) { .llm-sidebar { width:calc(100vw - 12px);
      } .llm-chat-dialog { width:calc(100vw - 16px); } .llm-history-wrap { padding-left:12px;padding-right:12px; } }
    </style>
    <button class="quickfind-trigger" type="button" aria-label="使用搜索引擎搜索选中文字" data-i18n-aria-label="使用搜索引擎搜索选中文字" aria-expanded="false" title="搜索选中文字" data-i18n-title="搜索选中文字">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
    </button>
    <section class="quickfind-panel" role="dialog" aria-label="搜索引擎列表" data-i18n-aria-label="搜索引擎列表">
      <div class="panel-drag-handle" role="button" tabindex="0" aria-label="长按拖动搜索列表" data-i18n-aria-label="长按拖动搜索列表" title="长按拖动搜索列表" data-i18n-title="长按拖动搜索列表"></div>
      <div class="panel-head"><div class="query-row"><textarea class="query-input" rows="1" aria-label="编辑搜索内容" data-i18n-aria-label="编辑搜索内容" autocomplete="off"></textarea><button class="query-expand" type="button" aria-label="展开多行输入" data-i18n-aria-label="展开多行输入" aria-expanded="false" title="展开多行输入" data-i18n-title="展开多行输入"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"></path></svg></button></div></div>
      <div class="engine-list"></div>
      <div class="hidden-engine-list" hidden></div>
      <div class="group-engine-list" hidden></div>
    </section>
    <div class="llm-dock" aria-label="右侧 LLM 对话" data-i18n-aria-label="右侧 LLM 对话">
      ${PAGE_SIDEBAR_ENABLED ? `
      <button class="llm-rail" type="button" aria-label="展开 LLM 对话" data-i18n-aria-label="展开 LLM 对话" aria-expanded="false" title="展开 LLM 对话" data-i18n-title="展开 LLM 对话"></button>
      <aside class="llm-sidebar" aria-label="LLM 聊天历史" data-i18n-aria-label="LLM 聊天历史" aria-hidden="true">
        <header class="llm-sidebar-head">
          <span class="llm-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5 12 3l7 3.5v7L12 17l-7-3.5Z"></path><path d="m8.5 8.5 3.5 1.8 3.5-1.8M12 10.3V17"></path></svg></span>
          <div><p class="llm-kicker">QUICKFIND / AI</p><h2 class="llm-title" data-i18n="随心问">随心问</h2></div>
          <button class="llm-sidebar-close" type="button" aria-label="收起 LLM 面板" data-i18n-aria-label="收起 LLM 面板" title="收起" data-i18n-title="收起"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg></button>
        </header>
        <div class="llm-tabbar" role="tablist" aria-label="面板功能" data-i18n-aria-label="面板功能">
          <button class="llm-tab is-active" type="button" role="tab" data-tab="chat" aria-selected="true" aria-controls="llm-pane-chat" title="随选随问的 AI 对话" data-i18n-title="随选随问的 AI 对话" data-i18n="随心问">随心问</button>
          <button class="llm-tab" type="button" role="tab" data-tab="outline" aria-selected="false" aria-controls="llm-pane-outline" title="无限层级的大纲笔记" data-i18n-title="无限层级的大纲笔记" data-i18n="无限大纲笔记">无限大纲笔记</button>
        </div>
        <div class="llm-pane" id="llm-pane-chat" data-pane="chat" role="tabpanel" aria-label="随心问" data-i18n-aria-label="随心问">
          <div class="llm-status-row"><span class="llm-status-dot" aria-hidden="true"></span><span class="llm-status-text"></span><button class="llm-new-chat" type="button" title="新建对话" data-i18n-title="新建对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span data-i18n="新对话">新对话</span></button></div>
          <div class="llm-history-wrap"><div class="llm-history-heading"><span data-i18n="最近对话">最近对话</span><span class="llm-history-count"></span></div><div class="llm-history-list"></div><div class="llm-history-empty" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"></path><path d="M8 9h8M8 12h5"></path></svg><strong data-i18n="从一个问题开始">从一个问题开始</strong><span data-i18n="你的对话会保存在这里，下一次打开可以继续。">你的对话会保存在这里，下一次打开可以继续。</span></div></div>
          <form class="llm-compose" novalidate><div class="llm-compose-box"><textarea class="llm-sidebar-input" rows="1" aria-label="输入问题" data-i18n-aria-label="输入问题" placeholder="问点什么…" data-i18n-placeholder="问点什么…"></textarea><div class="llm-compose-bottom"><span class="llm-compose-hint" data-i18n="Enter 发送 · Shift+Enter 换行">Enter 发送 · Shift+Enter 换行</span><button class="llm-send" type="submit" aria-label="发送问题" data-i18n-aria-label="发送问题" title="发送" data-i18n-title="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z"></path><path d="M7 12h13"></path></svg></button></div></div></form>
        </div>
        <div class="llm-pane" id="llm-pane-outline" data-pane="outline" role="tabpanel" aria-label="无限大纲笔记" data-i18n-aria-label="无限大纲笔记" hidden>
          <div class="outline-toolbar">
            <label class="outline-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5"></circle><path d="m16 16 4 4"></path></svg><input class="outline-search-input" type="search" placeholder="搜索笔记" data-i18n-placeholder="搜索笔记" aria-label="搜索笔记" data-i18n-aria-label="搜索笔记" /></label>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="undo" title="撤销（Ctrl/⌘+Z）" data-i18n-title="撤销（Ctrl/⌘+Z）" aria-label="撤销" data-i18n-aria-label="撤销" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"></path><path d="M4 12h9a6 6 0 0 1 6 6v1"></path></svg></button>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="redo" title="重做（Ctrl/⌘+Shift+Z）" data-i18n-title="重做（Ctrl/⌘+Shift+Z）" aria-label="重做" data-i18n-aria-label="重做" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 5 5-5 5"></path><path d="M20 12h-9a6 6 0 0 0-6 6v1"></path></svg></button>
            <button class="outline-tool-button" type="button" data-outline-action="add-note" title="新建项目" data-i18n-title="新建项目"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span data-i18n="新建">新建</span></button>
            <button class="outline-tool-button" type="button" data-outline-action="insert-selection" title="把页面上选中的文字加入笔记" data-i18n-title="把页面上选中的文字加入笔记" data-i18n="插入">插入</button>
          </div>
          <div class="outline-context">
            <button class="outline-home" type="button" data-outline-action="home" aria-label="返回根目录" data-i18n-aria-label="返回根目录" title="返回根目录" data-i18n-title="返回根目录" data-i18n="根目录">根目录</button>
            <span class="outline-context-separator" aria-hidden="true">/</span>
            <div class="outline-breadcrumb" aria-live="polite">根目录</div>
            <span class="outline-search-result" aria-live="polite"></span>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="expand" title="展开全部" data-i18n-title="展开全部" aria-label="展开全部" data-i18n-aria-label="展开全部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="collapse" title="收起全部" data-i18n-title="收起全部" aria-label="收起全部" data-i18n-aria-label="收起全部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg></button>
          </div>
          <div class="outline-scroll"><div class="outline-list" role="tree" aria-label="大纲笔记" data-i18n-aria-label="大纲笔记"></div></div>
        </div>
      </aside>
      ` : ''}
      <!-- 无蒙版：容器只负责定位与层叠，窗口由 createLlmChatWindow 动态挂进来，可同时开多个。 -->
      <div class="llm-chat-layer" hidden></div>
      <template class="llm-chat-window-template">
        <section class="llm-chat-dialog" role="dialog" aria-label="LLM 对话" data-i18n-aria-label="LLM 对话">
          <header class="llm-chat-head"><button class="llm-chat-back" type="button" aria-label="返回对话" data-i18n-aria-label="返回对话" title="返回对话" data-i18n-title="返回对话" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg></button><span class="llm-chat-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5 12 3l7 3.5v7L12 17l-7-3.5Z"></path><path d="m8.5 8.5 3.5 1.8 3.5-1.8M12 10.3V17"></path></svg></span><div class="llm-chat-head-copy"><div class="llm-chat-title" data-i18n="新对话">新对话</div><div class="llm-chat-subtitle" data-i18n="LLM 助手">LLM 助手</div></div><button class="llm-chat-history-btn" type="button" aria-label="查看历史会话" data-i18n-aria-label="查看历史会话" title="历史会话" data-i18n-title="历史会话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path><path d="M12 7v5l3 2"></path></svg></button><button class="llm-chat-pin" type="button" aria-label="置顶窗口" data-i18n-aria-label="置顶窗口" aria-pressed="false" title="置顶窗口" data-i18n-title="置顶窗口"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3.5 3.5H5.5L9 10Z"></path><path d="M12 13.5V20"></path></svg></button><button class="llm-chat-close" type="button" aria-label="关闭对话" data-i18n-aria-label="关闭对话" title="关闭" data-i18n-title="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></header>
          <div class="llm-chat-scroll" aria-live="polite"></div>
          <div class="llm-chat-history" hidden><div class="llm-chat-history-head"><span data-i18n="最近对话">最近对话</span><span class="llm-chat-history-count"></span></div><div class="llm-chat-history-list"></div></div>
          <button class="llm-chat-jump" type="button" aria-label="回到底部" data-i18n-aria-label="回到底部" title="回到底部" data-i18n-title="回到底部" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"></path></svg></button>
          <form class="llm-chat-compose" novalidate><div class="llm-chat-footer-note" data-i18n="回答由你配置的模型生成">回答由你配置的模型生成</div><div class="llm-compose-box"><textarea class="llm-chat-input" rows="1" aria-label="继续提问" data-i18n-aria-label="继续提问" placeholder="继续追问…" data-i18n-placeholder="继续追问…"></textarea><div class="llm-compose-bottom"><span class="llm-compose-hint" data-i18n="Enter 发送 · Shift+Enter 换行">Enter 发送 · Shift+Enter 换行</span><button class="llm-send" type="submit" aria-label="发送消息" data-i18n-aria-label="发送消息" title="发送" data-i18n-title="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z"></path><path d="M7 12h13"></path></svg></button></div></div></form>
          <div class="llm-chat-resize" role="separator" aria-label="调整窗口大小" data-i18n-aria-label="调整窗口大小" title="拖动调整大小" data-i18n-title="拖动调整大小"></div>
        </section>
      </template>
    </div>
  `;
  // 模板里的静态文案统一带 data-i18n，设置读回后再按真实语言刷一次（见 loadSettings）。
  applyI18n(shadow);

  const trigger = shadow.querySelector('.quickfind-trigger');
  const panel = shadow.querySelector('.quickfind-panel');
  const queryInput = shadow.querySelector('.query-input');
  const queryExpand = shadow.querySelector('.query-expand');
  const queryRow = shadow.querySelector('.query-row');
  const panelDragHandle = shadow.querySelector('.panel-drag-handle');
  const engineList = shadow.querySelector('.engine-list');
  const hiddenEngineList = shadow.querySelector('.hidden-engine-list');
  const groupEngineList = shadow.querySelector('.group-engine-list');
  const llmDock = shadow.querySelector('.llm-dock');
  const llmRail = shadow.querySelector('.llm-rail');
  const llmSidebar = shadow.querySelector('.llm-sidebar');
  const llmSidebarClose = shadow.querySelector('.llm-sidebar-close');
  const llmNewChat = shadow.querySelector('.llm-new-chat');
  const llmStatusDot = shadow.querySelector('.llm-status-dot');
  const llmStatusText = shadow.querySelector('.llm-status-text');
  const llmHistoryList = shadow.querySelector('.llm-history-list');
  const llmHistoryEmpty = shadow.querySelector('.llm-history-empty');
  const llmHistoryCount = shadow.querySelector('.llm-history-count');
  const llmSidebarCompose = shadow.querySelector('.llm-compose');
  const llmSidebarInput = shadow.querySelector('.llm-sidebar-input');
  const llmChatLayer = shadow.querySelector('.llm-chat-layer');
  const llmChatWindowTemplate = shadow.querySelector('.llm-chat-window-template') as HTMLTemplateElement | null;
  const llmTabbar = shadow.querySelector('.llm-tabbar');
  const llmTitle = shadow.querySelector('.llm-title');
  const outlineSearchInput = shadow.querySelector('.outline-search-input');
  const outlineSearchResult = shadow.querySelector('.outline-search-result');
  const outlineBreadcrumb = shadow.querySelector('.outline-breadcrumb');
  const outlineHomeButton = shadow.querySelector('[data-outline-action="home"]');
  const outlineUndoButton = shadow.querySelector('[data-outline-action="undo"]');
  const outlineRedoButton = shadow.querySelector('[data-outline-action="redo"]');
  const outlineAddButton = shadow.querySelector('[data-outline-action="add-note"]');
  const outlineExpandButton = shadow.querySelector('[data-outline-action="expand"]');
  const outlineCollapseButton = shadow.querySelector('[data-outline-action="collapse"]');
  const outlineInsertSelection = shadow.querySelector('[data-outline-action="insert-selection"]');
  const outlineList = shadow.querySelector('.outline-list');

  function cloneSettings(source) {
    return {
      enabled: source.enabled !== false,
      engines: { ...DEFAULT_SETTINGS.engines, ...(source.engines || {}) },
      iconOnly: { ...(source.iconOnly || {}) },
      customEngines: Array.isArray(source.customEngines) ? source.customEngines : [],
      engineOrder: Array.isArray(source.engineOrder) ? source.engineOrder : DEFAULT_SETTINGS.engineOrder,
      sources: Array.isArray(source.sources) ? source.sources : DEFAULT_SETTINGS.sources,
      groups: Array.isArray(source.groups) ? source.groups : DEFAULT_SETTINGS.groups,
      // 特殊功能按钮的显示设置（目前只有仅图标）：收敛与读取都在 shared/settings-store.ts。
      specialActions: source.specialActions && typeof source.specialActions === 'object' ? source.specialActions : {},
      sourceConfigVersion: Number(source.sourceConfigVersion) || 0,
      pinnedSearch: source.pinnedSearch && typeof source.pinnedSearch === 'object' ? source.pinnedSearch : DEFAULT_SETTINGS.pinnedSearch,
      searchHistory: Array.isArray(source.searchHistory) ? source.searchHistory : [],
      llm: normalizeLlmConfig(source.llm),
      language: normalizeLocale(source.language),
      triggerMode: source.triggerMode === 'hover' ? 'hover' : 'click',
      editableTriggerMode: ['click', 'hover', 'none'].includes(source.editableTriggerMode) ? source.editableTriggerMode : DEFAULT_SETTINGS.editableTriggerMode,
      defaultGroupCount: Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(source.defaultGroupCount ?? source.defaultVisibleCount ?? DEFAULT_SETTINGS.defaultGroupCount) || DEFAULT_SETTINGS.defaultGroupCount))),
      selectionTriggerDelay: Math.max(0, Math.min(2000, Math.round(Number(source.selectionTriggerDelay ?? 200) || 0))),
      llmDockVisible: typeof source.llmDockVisible === 'boolean' ? source.llmDockVisible : DEFAULT_SETTINGS.llmDockVisible
    };
  }

  function normalizeLlmConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.llm.enabled,
      endpoint: String(source.endpoint || source.baseUrl || DEFAULT_SETTINGS.llm.endpoint).trim(),
      model: String(source.model || DEFAULT_SETTINGS.llm.model).trim(),
      apiKey: String(source.apiKey || source.key || ''),
      systemPrompt: String(source.systemPrompt || '').trim()
    };
  }

  function normalizeLlmConversation(value) {
    if (!value || typeof value !== 'object') return null;
    const messages = Array.isArray(value.messages) ? value.messages.map((message) => {
      if (!message || !['user', 'assistant', 'system'].includes(message.role)) return null;
      const content = String(message.content || '').trim();
      return content ? { role: message.role, content } : null;
    }).filter(Boolean).filter((message) => message.role !== 'system') : [];
    if (!messages.length) return null;
    const now = Date.now();
    return {
      id: String(value.id || `llm-${now}-${Math.random().toString(36).slice(2, 8)}`),
      messages,
      createdAt: Number(value.createdAt) || now,
      updatedAt: Number(value.updatedAt) || Number(value.createdAt) || now
    };
  }

  function readLlmConversations() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      return new Promise((resolve) => chrome.storage.local.get(LLM_CONVERSATIONS_KEY, (stored) => resolve(stored?.[LLM_CONVERSATIONS_KEY])));
    }
    try { return Promise.resolve(JSON.parse(localStorage.getItem(LLM_CONVERSATIONS_KEY) || '[]')); } catch { return Promise.resolve([]); }
  }

  function writeLlmConversations() {
    const payload = llmConversations.slice(0, 30);
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      chrome.storage.local.set({ [LLM_CONVERSATIONS_KEY]: payload });
      return;
    }
    try { localStorage.setItem(LLM_CONVERSATIONS_KEY, JSON.stringify(payload)); } catch { /* storage may be unavailable */ }
  }

  function loadLlmConversations() {
    if (loadLlmConversations.started) return;
    loadLlmConversations.started = true;
    void readLlmConversations().then((value) => {
      llmConversations = (Array.isArray(value) ? value : []).map(normalizeLlmConversation).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
      renderLlmHistory();
    });
  }

  function llmHasConfig() {
    const config = normalizeLlmConfig(settings?.llm);
    const localEndpoint = /(?:localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(config.endpoint);
    return config.enabled !== false && Boolean(config.endpoint && config.model && (config.apiKey || localEndpoint));
  }

  function syncLlmConfigStatus(kind = '') {
    if (!llmStatusDot || !llmStatusText) return;
    const config = normalizeLlmConfig(settings?.llm);
    llmStatusDot.classList.remove('ready', 'busy', 'error');
    if (kind === 'busy') {
      llmStatusDot.classList.add('busy');
      llmStatusText.textContent = t('正在思考…');
      return;
    }
    if (kind === 'error') {
      llmStatusDot.classList.add('error');
      llmStatusText.textContent = t('请求未完成');
      return;
    }
    if (config.enabled === false) {
      llmStatusText.textContent = t('LLM 已关闭');
      return;
    }
    if (!config.endpoint || !config.model || !config.apiKey) {
      llmStatusText.textContent = t('待配置 API Key');
      return;
    }
    llmStatusDot.classList.add('ready');
    llmStatusText.textContent = t('{n} · 已配置', { n: config.model });
  }

  function formatLlmTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return '';
    try {
      return new Intl.DateTimeFormat(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    } catch { return ''; }
  }

  function firstMessage(conversation, role) {
    return conversation?.messages?.find((message) => message.role === role)?.content || '';
  }

  function shortenLlmText(value, limit = 92) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  /**
   * 删掉一段会话。
   *
   * 存储里去掉之后，正开着这段会话的窗口也要一起关掉——否则窗口里留下的是一份
   * 已经不在列表里的会话，用户再发一条消息又会把它写回去，「删了又回来」。
   * 几何记忆也一并清掉，不然下次开一段新会话若撞上同一个 id 会继承旧位置。
   */
  function deleteLlmConversation(conversationId: any) {
    const id = String(conversationId || '');
    if (!id) return;
    // 用带类型的局部视图操作会话列表：模块级的 llmConversations 是隐式 any，
    // 每引用一次就记一个类型错误（见 README 的记账口径），所以只碰一次。
    const list: any[] = llmConversations;
    const at = list.findIndex((item: any) => String(item?.id) === id);
    if (at < 0) return;
    list.splice(at, 1);
    // 历史列表靠内容指纹跳过无变化的重建，删除后必须让它重算。
    llmHistorySignature = '';
    // 先关窗口（closeLlmChatWindow 会把当前几何写回存储），再删几何记忆——
    // 顺序反了的话，关窗口那一步会把刚删掉的条目又写回来。
    llmChatWindows.slice().forEach((win) => { if (String(win.conversation?.id) === id) closeLlmChatWindow(win); });
    const table = readLlmWindowGeometry();
    if (table[id]) { delete table[id]; persistLlmWindowGeometry(); }
    writeLlmConversations();
    renderLlmHistory();
    llmChatWindows.forEach((win) => { if (win.state === 'history') renderLlmChatHistory(win); });
  }

  /**
   * 建一张历史会话卡片，侧栏与窗口内的历史视图共用。
   *
   * 卡片本体是 div[role=button] 而不是 button：里面要放删除按钮，而 button 不能嵌套
   * button——浏览器会把内层拆到外面，删除按钮就点不到了。键盘语义用 keydown 手写。
   */
  function createLlmHistoryCard(conversation: any, onOpen: () => void) {
    const card = document.createElement('div');
    card.className = 'llm-history-card';
    card.dataset.conversationId = conversation.id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const body = document.createElement('div');
    body.className = 'llm-card-body';
    const title = document.createElement('strong');
    title.className = 'llm-card-title';
    title.textContent = shortenLlmText(firstMessage(conversation, 'user'), 72) || t('未命名对话');
    const preview = document.createElement('span');
    preview.className = 'llm-card-preview';
    preview.textContent = shortenLlmText(markdownToPlainText(firstMessage(conversation, 'assistant')), 118) || t('等待 LLM 回复…');
    const meta = document.createElement('span');
    meta.className = 'llm-card-meta';
    const count = conversation.messages.filter((message) => message.role === 'user').length;
    meta.textContent = `${formatLlmTime(conversation.updatedAt)}  ·  ${countText(count, '1 次提问', '{n} 次提问')}`;
    body.append(title, preview, meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'llm-card-delete';
    const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"></path></svg>';
    del.innerHTML = DELETE_ICON;
    del.setAttribute('aria-label', t('删除这段对话'));
    del.setAttribute('title', t('删除这段对话'));
    // 删除走两步：第一下只「上膛」并换成「确认删除」，再点一下才真删。
    // 点击不能让卡片收到（否则会顺手打开这段对话），所以这里都要拦住传播。
    let armed = false;
    const disarm = () => {
      armed = false;
      del.classList.remove('is-armed');
      del.innerHTML = DELETE_ICON;
      del.setAttribute('aria-label', t('删除这段对话'));
      del.setAttribute('title', t('删除这段对话'));
    };
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('is-armed');
        del.textContent = t('确认删除');
        del.setAttribute('aria-label', t('确认删除这段对话'));
        return;
      }
      deleteLlmConversation(conversation.id);
    });
    // 指针离开卡片就撤掉「已上膛」：避免用户改主意后又无意点到。
    del.addEventListener('pointerleave', () => { if (armed) disarm(); });
    del.addEventListener('keydown', (event) => { if (event.key === 'Escape' && armed) { event.stopPropagation(); disarm(); } });
    card.append(body, del);
    card.addEventListener('click', () => onOpen());
    card.addEventListener('keydown', (event) => {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
    });
    return card;
  }

  function renderLlmHistory() {
    if (!llmHistoryList) return;
    const conversations = llmConversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    // 内容没有变化时不要重建 DOM：重建会毁掉正在按下（mousedown 之后、mouseup 之前）
    // 的那张卡片，浏览器因此不会派发 click 事件，历史对话就点不动了。
    const signature = getLocale() + JSON.stringify(conversations);
    if (signature === llmHistorySignature) return;
    llmHistorySignature = signature;
    llmHistoryList.replaceChildren();
    if (llmHistoryCount) llmHistoryCount.textContent = conversations.length ? t('{n} 条', { n: conversations.length }) : '';
    if (llmHistoryEmpty) llmHistoryEmpty.hidden = conversations.length > 0;
    conversations.forEach((conversation) => {
      llmHistoryList.append(createLlmHistoryCard(conversation, () => openLlmConversation(conversation)));
    });
  }

  function resizeLlmTextarea(input) {
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = 128;
    input.style.height = `${Math.max(52, Math.min(maxHeight, input.scrollHeight || 52))}px`;
    input.style.overflowY = (input.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
  }

  /**
   * 宿主显隐的唯一出口。
   *
   * 「问 ai」的对话层与右侧栏共用同一个宿主：选项页关掉「随心问」面板时，侧栏与滑杆不该出现，
   * 但对话面板仍要能显示。所以宿主是否可见 = 侧栏可用 **或** 对话层正开着，
   * 两者都不成立时才把整层隐藏。chat-only 类负责压掉滑杆与侧栏。
   */
  function syncLlmDockHostVisibility() {
    // 用带类型的局部视图读 DOM：模块级的 querySelector 结果是 Element，
    // 直接读 .hidden 每引用一次就记一个类型错误（见 README 的记账口径）。
    const dock = llmDock as HTMLElement | null;
    if (!dock) return;
    const sidebarAvailable = PAGE_SIDEBAR_ENABLED && settings.llmDockVisible !== false;
    const chatOpen = llmChatWindows.length > 0;
    dock.classList.toggle('is-chat-only', !sidebarAvailable);
    dock.hidden = !(sidebarAvailable || chatOpen);
  }

  /** 还占着宿主的浮层：右侧栏或任一对话窗口。收起路径用它判断能否把宿主撤出 top layer。 */
  function llmOverlayInUse(): boolean {
    return llmDockOpen || llmChatWindows.length > 0;
  }

  /**
   * 没有任何浮层再用主宿主时，把它撤出 top layer。
   *
   * 必须成对：宿主一旦留在 top layer 就是一个透明的整屏层，会挡住页面自己的弹窗与控件，
   * 而这种缺陷在正常截图里看不出来（见 tests/verify-top-layer.cjs）。
   * 「问 ai」把对话层放进了主宿主，于是收起对话层后要在这里补上收回动作。
   */
  function demoteHostIfIdle() {
    const triggerEl = trigger as HTMLElement | null;
    if (llmOverlayInUse()) return;
    if (panelOpen || triggerEl?.classList.contains('visible')) return;
    demoteFromTopLayer(host);
  }

  /** 右侧「随心问」面板的显示开关（选项页可配置）。隐藏时顺手收起，避免留下半开状态。 */
  function setLlmDockVisible(visible: unknown) {
    const next = visible !== false;
    settings.llmDockVisible = next;
    if (!next) setLlmDockOpen(false);
    syncLlmDockHostVisibility();
  }

  /**
   * 打开/收起右侧面板。
   *
   * pinned 为真表示这次是用户主动点开的——面板将持续显示，直到用户再点一次、
   * 按关闭按钮、或从选项页关掉开关。指针离开不再自动收起它：收起路径里那套
   * 「鼠标移开就收」是为旧的划过展开设计的，用在点击展开上会变成「刚点开就消失」。
   */
  function setLlmDockOpen(open: boolean, options: { pinned?: boolean } = {}) {
    if (!llmDock) return;
    // 侧栏已下线（shared/features.ts）：滑杆与面板都不在 DOM 里，任何展开请求都到此为止。
    // 对话窗口（showLlmChatLayer）不走这里，它自己负责宿主的显隐。
    if (!PAGE_SIDEBAR_ENABLED) return;
    // 侧栏不可用时不允许展开侧栏。但对话窗口（showLlmChatLayer）与侧栏共用一个宿主，
    // 它的显示不受「随心问」开关约束——「问 ai」在关掉侧栏的配置下依然要能弹出来。
    if (open && settings.llmDockVisible === false && !llmChatWindows.length) return;
    if (llmCloseTimer) window.clearTimeout(llmCloseTimer);
    llmCloseTimer = null;
    const nextOpen = Boolean(open);
    if (!nextOpen) llmDockPinnedOpen = false;
    else if (options.pinned) llmDockPinnedOpen = true;
    // 只有状态真正发生变化时才刷新内容/抢焦点，否则 focusin、pointerenter 这类
    // 高频事件会在用户按下卡片时重建列表，导致 click 事件丢失。
    const justOpened = nextOpen && !llmDockOpen;
    llmDockOpen = nextOpen;
    llmDock.classList.toggle('is-open', nextOpen);
    llmRail?.setAttribute('aria-expanded', String(nextOpen));
    llmRail?.setAttribute('aria-label', nextOpen ? t('收起 QuickFind 面板') : t('展开 QuickFind 面板'));
    if (llmSidebar) llmSidebar.setAttribute('aria-hidden', String(!nextOpen));
    if (!nextOpen) return;
    if (llmActiveTab === 'outline') {
      // 大纲列表重绘时会把焦点还给输入框，再次触发 focusin；若这里无条件重载，
      // 就会 focusin → loadOutlineNotes → renderNotes → focusin 无限递归。
      if (justOpened) loadOutlineNotes();
      syncOutlineInsertButton();
      return;
    }
    renderLlmHistory();
    if (justOpened) window.requestAnimationFrame(() => { if (!llmChatWindows.length) llmSidebarInput?.focus({ preventScroll: true }); });
  }

  function scheduleLlmDockClose() {
    if (llmChatWindows.length) return;
    // 用户点开的：不自动收。保留自动收只对「程序化打开」这种临时展示有意义。
    if (llmDockPinnedOpen) return;
    if (llmCloseTimer) window.clearTimeout(llmCloseTimer);
    llmCloseTimer = window.setTimeout(() => {
      llmCloseTimer = null;
      const activeElement = shadow.activeElement;
      const editing = (activeElement === llmSidebarInput && Boolean(llmSidebarInput?.value.trim()))
        || activeElement?.classList?.contains('note-input')
        || activeElement === outlineSearchInput;
      if (!llmRail?.matches(':hover') && !llmSidebar?.matches(':hover') && !editing) setLlmDockOpen(false);
    }, 260);
  }

  /**
   * 对话窗口的几何记忆：位置、大小、置顶随会话 id 落在本地存储里，跨刷新恢复。
   *
   * 用 local 而不是 sync：窗口位置是「这台设备这块屏」的属性，同步到别的设备上反而错位。
   * 存储坏了就当作没有记忆，退回默认布局，不让它影响窗口能否打开。
   */
  let llmWindowGeometry: Record<string, { left?: number; top?: number; width?: number; height?: number; pinned?: boolean }> | null = null;
  /** 几何读盘的进度。窗口是同步建的，而读存储是异步的——见 ensureLlmWindowGeometry 的兜底。 */
  let llmGeometryReady: Promise<void> | null = null;

  /**
   * 保证几何表已从存储读出，返回它的 Promise。
   *
   * 读盘必须在**建窗口之前**完成，否则第一个窗口会拿到空表、落到默认位置，
   * 用户看到的「位置没记住」就是这么来的。这里既做一次性加载，也在加载完成时
   * 回头把已建好的窗口重新摆正——调用方不必自己 await。
   */
  function ensureLlmWindowGeometry(): Promise<void> {
    if (llmGeometryReady) return llmGeometryReady;
    llmGeometryReady = new Promise<void>((resolve) => {
      const settle = (value: unknown) => {
        llmWindowGeometry = value && typeof value === 'object' ? (value as Record<string, any>) : {};
        // 加载晚于建窗口时，把已有窗口按记忆重新摆好。
        llmChatWindows.forEach((win) => applyLlmWindowGeometry(win));
        resolve();
      };
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.get(LLM_WINDOW_GEOMETRY_KEY, (stored) => settle(stored?.[LLM_WINDOW_GEOMETRY_KEY]));
          return;
        }
        const raw = localStorage.getItem(LLM_WINDOW_GEOMETRY_KEY);
        settle(raw ? JSON.parse(raw) : null);
      } catch { settle(null); }
    });
    return llmGeometryReady;
  }

  function readLlmWindowGeometry(): Record<string, any> {
    return (llmWindowGeometry || {}) as Record<string, any>;
  }

  function persistLlmWindowGeometry(): void {
    const payload = llmWindowGeometry || {};
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) { chrome.storage.local.set({ [LLM_WINDOW_GEOMETRY_KEY]: payload }); return; }
      localStorage.setItem(LLM_WINDOW_GEOMETRY_KEY, JSON.stringify(payload));
    } catch { /* 存不下就算了，几何只是便利，不是功能 */ }
  }

  /** 按记忆摆正一个窗口（位置、大小、置顶）。没有会话记忆时只继承全局尺寸，位置保持现状。 */
  function applyLlmWindowGeometry(win) {
    const root = win?.root as HTMLElement | null;
    if (!root || !win.geometryKey) return;
    const table = readLlmWindowGeometry();
    const saved = table[win.geometryKey];
    // 尺寸回落顺序：本会话记忆 → 全局上次尺寸。「问 ai」每次都是新会话，没有全局那份就永远
    // 回落到默认值，用户拖好的大小每次都白费。
    const size = saved || table[LLM_WINDOW_SIZE_KEY];
    if (Number.isFinite(size?.width)) root.style.width = `${size.width}px`;
    if (Number.isFinite(size?.height)) root.style.height = `${size.height}px`;
    // 位置只认会话记忆：全局那份不含位置，缺了就用当前（默认错开的）落点。
    if (Number.isFinite(saved?.left)) root.style.left = `${saved.left}px`;
    if (Number.isFinite(saved?.top)) root.style.top = `${saved.top}px`;
    if (typeof saved?.pinned === 'boolean') setLlmWindowPinned(win, saved.pinned);
    clampLlmWindowRect(root);
  }

  /** 记住某个窗口的当前几何。关闭与拖动/缩放结束时各调一次。 */
  function rememberLlmWindowGeometry(win) {
    const root = win?.root as HTMLElement | null;
    if (!root || !win.geometryKey) return;
    const table = readLlmWindowGeometry();
    const rect = {
      left: Math.round(root.offsetLeft),
      top: Math.round(root.offsetTop),
      width: Math.round(root.offsetWidth),
      height: Math.round(root.offsetHeight),
      pinned: Boolean(win.pinned)
    };
    // 尺寸每次都额外记一份全局的：新会话按自己的键取不到记忆时靠它继承。
    table[LLM_WINDOW_SIZE_KEY] = { width: rect.width, height: rect.height };
    // draft 键的生命周期只有「开了窗口、还没发出第一条消息」这一段，下一次开窗又是新键。
    // 以它为键记账永远命中不到，只会让存储无界增长——尺寸已由上面那份全局记忆兜住。
    if (!String(win.geometryKey).startsWith('draft-')) table[win.geometryKey] = rect;
    persistLlmWindowGeometry();
  }

  /** 默认落点：靠右往下逐级错开，避免多个窗口完全重叠。 */
  function defaultLlmWindowRect() {
    const width = Math.min(420, Math.max(280, window.innerWidth - 32));
    const height = Math.min(560, Math.max(240, window.innerHeight - 32));
    const step = (llmWindowCascade % 5) * 26;
    llmWindowCascade += 1;
    const left = Math.max(12, window.innerWidth - width - 16 - step);
    const top = Math.max(12, 16 + step);
    return { left, top, width, height };
  }

  /**
   * 把窗口夹回可抓取的范围内，并返回是否移动过。
   *
   * 规则要**一致**（此前 961 行允许挂到屏外、964 行又立刻禁止，自相矛盾）：
   * 横向至少留 80px 在视口内，纵向保证标题栏（拖动把手）完整可见——否则窗口没法再被拖回来。
   *
   * 关键：拖动过程中**每帧**都要调用它，不能只在松手时调。只在松手时夹会让「拖到边界外」
   * 变成「松手瞬间被拽回来」，用户看到的就是一次突兀的跳变，正是「一闪」的来源之一。
   */
  function clampLlmWindowRect(root: HTMLElement) {
    // 还没进布局时 offsetWidth/offsetLeft 恒为 0，按下面的公式会被算成「0×0 放在左上角」，
    // 于是把窗口压到最小值并贴到 (0,0)。层/宿主此刻可能还藏着（例如侧栏关掉时的
    // 「问 ai」路径），这里先放过：等真正可见后拖动、缩放或 applyLlmWindowGeometry 会再夹一次。
    if (!root.offsetWidth || !root.offsetHeight) return false;
    const headHeight = 61; // .llm-chat-head 的 min-height，标题栏必须留在视口里才抓得住
    const margin = 8;
    const width = Math.max(280, Math.min(root.offsetWidth, window.innerWidth - margin * 2));
    const height = Math.max(240, Math.min(root.offsetHeight, window.innerHeight - margin * 2));
    const minLeft = -(width - 80);
    const maxLeft = Math.max(minLeft, window.innerWidth - 80);
    const maxTop = Math.max(0, window.innerHeight - headHeight);
    const left = Math.max(minLeft, Math.min(root.offsetLeft, maxLeft));
    const top = Math.max(0, Math.min(root.offsetTop, maxTop));
    const nextLeft = Math.round(left);
    const nextTop = Math.round(top);
    const nextWidth = Math.round(width);
    const nextHeight = Math.round(height);
    const changed = root.offsetLeft !== nextLeft || root.offsetTop !== nextTop
      || root.offsetWidth !== nextWidth || root.offsetHeight !== nextHeight;
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.width = `${nextWidth}px`;
    root.style.height = `${nextHeight}px`;
    return changed;
  }

  /** 抬到同层最前。置顶窗口另占更高的层级段，普通窗口之间按打开顺序递增。 */
  let llmWindowZ = 0;
  function raiseLlmChatWindow(win) {
    if (!win?.root) return;
    llmWindowZ += 1;
    const root = win.root as HTMLElement;
    root.style.zIndex = String((win.pinned ? 1000 : 0) + llmWindowZ);
  }

  /** 设置置顶状态：类名、ARIA 与层级一起改，别只改其中一个（否则界面与行为会对不上）。 */
  function setLlmWindowPinned(win, pinned) {
    const root = win?.root as HTMLElement | null;
    if (!root) return;
    win.pinned = Boolean(pinned);
    root.classList.toggle('is-pinned', Boolean(win.pinned));
    win.pin?.setAttribute('aria-pressed', String(Boolean(win.pinned)));
    win.pin?.classList.toggle('is-active', Boolean(win.pinned));
    raiseLlmChatWindow(win);
  }

  /**
   * 拖动（整个标题栏，按钮除外）与缩放（右下角抓手）。
   *
   * 指针逻辑挂在 window 上并用 setPointerCapture：窗口在拖动过程中可能因为重排离开原位，
   * 只在元素上监听会丢事件。拖动期间加 `is-dragging` 关掉过渡，避免与位移打架。
   *
   * 三个防闪烁要点：
   *   1. **写入按帧合并**：pointermove 在部分设备上比屏幕刷新率密得多，每个事件都写一次
   *      style 会造成一帧内多次布局，视觉上就是抖。这里只记最新目标值，由 rAF 每帧落一次盘。
   *   2. **每帧夹边界**：不能只在松手时夹，否则「拖到边界外再松手」会突然被拽回来（一次跳变）。
   *   3. **松手不再写位置**：夹边界已在帧内做完，finish 只做状态收尾；重复写还是老值。 */
  function attachLlmWindowDrag(win, handle: HTMLElement, mode: 'move' | 'resize') {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      // 标题栏上的按钮不参与拖动：那是点击目标，不是抓手。
      if (mode === 'move' && (event.target as Element | null)?.closest?.('button')) return;
      const root = win.root as HTMLElement | null;
      if (!root) return;
      event.preventDefault();
      raiseLlmChatWindow(win);
      root.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing');
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = { left: root.offsetLeft, top: root.offsetTop, width: root.offsetWidth, height: root.offsetHeight };
      try { handle.setPointerCapture(event.pointerId); } catch { /* 捕获失败也照常走 window 监听 */ }
      // 目标几何（未夹边界前的原始意图）。rAF 拿到它之后夹边界并落盘。
      let target = { left: startRect.left, top: startRect.top, width: startRect.width, height: startRect.height };
      let dirty = false;
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (!dirty) return;
        dirty = false;
        if (mode === 'move') { root.style.left = `${target.left}px`; root.style.top = `${target.top}px`; }
        else { root.style.width = `${target.width}px`; root.style.height = `${target.height}px`; }
        clampLlmWindowRect(root);
      };
      const schedule = () => { if (!frame) frame = window.requestAnimationFrame(flush); };
      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (mode === 'move') target = { ...target, left: startRect.left + dx, top: startRect.top + dy };
        else target = { ...target, width: Math.max(280, startRect.width + dx), height: Math.max(240, startRect.height + dy) };
        dirty = true;
        schedule();
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        if (frame) window.cancelAnimationFrame(frame);
        flush(); // 收尾落一次盘；夹边界已在 flush 内完成，这里不再单独夹，避免二次跳变
        root.classList.remove('is-dragging', 'is-resizing');
        rememberLlmWindowGeometry(win);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
    });
  }

  /**
   * 助手回复渲染出的 HTML 缓存。
   *
   * renderLlmChatWindow 每次都整表重建——消息列表不长，重建换来的是「用户往上翻时不会被
   * 新回复拽回底部」这类行为上的简单性。代价是每次重建都要把历史里每条助手回复的 Markdown
   * 重新解析一遍，而一次问答至少触发两次重建（发出去、回回来）。这里按消息对象记住上次的
   * 渲染结果，内容没变就直接复用字符串，长对话下省掉的是 O(历史条数) 的重复解析。
   *
   * 用 WeakMap：消息对象就是 conversation.messages 里的那一个，随会话一起被回收，
   * 不需要自己维护失效。
   */
  const llmMessageHtmlCache = new WeakMap<object, { content: string; html: string }>();

  /** 在窗口区域里渲染对话流（Markdown）。用户消息保持纯文本，助手回复按 Markdown 排版。 */
  function renderLlmChatWindow(win) {
    const scroll = win?.scroll as HTMLElement | null;
    if (!scroll) return;
    // 气泡重建前先记位置：用户在往上翻时不该被新回复拽回底部。
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    scroll.replaceChildren();
    const messages = win.conversation?.messages || [];
    messages.forEach((message) => {
      const row = document.createElement('div');
      row.className = `llm-message ${message.role}`;
      const label = document.createElement('span');
      label.className = 'llm-message-label';
      label.textContent = message.role === 'user' ? t('你') : 'LLM';
      const bubble = document.createElement('div');
      bubble.className = 'llm-message-bubble';
      if (message.role === 'user') {
        bubble.textContent = message.content;
      } else {
        // 助手回复渲染 Markdown。渲染器只输出自己产生的标签（见 shared/markdown.ts 的安全边界）。
        const body = document.createElement('div');
        body.className = 'llm-md';
        const cached = llmMessageHtmlCache.get(message);
        if (cached && cached.content === message.content) {
          body.innerHTML = cached.html;
        } else {
          const html = renderMarkdown(message.content);
          llmMessageHtmlCache.set(message, { content: message.content, html });
          body.innerHTML = html;
        }
        bubble.append(body);
      }
      row.append(label, bubble);
      scroll.append(row);
    });
    if (win.requestInFlight) {
      const row = document.createElement('div');
      row.className = 'llm-message assistant pending';
      const label = document.createElement('span');
      label.className = 'llm-message-label';
      label.textContent = 'LLM';
      const bubble = document.createElement('div');
      bubble.className = 'llm-message-bubble';
      bubble.innerHTML = '<span class="llm-typing" aria-label="' + t('正在生成回复') + '"><i></i><i></i><i></i></span>';
      row.append(label, bubble);
      scroll.append(row);
    }
    updateLlmChatJump(win);
    if (nearBottom) window.requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  /** 「回到底部」按钮的显隐：只在用户往上翻、且内容确实超出可视区时出现。 */
  function updateLlmChatJump(win) {
    const scroll = win?.scroll as HTMLElement | null;
    const jump = win?.jump as HTMLElement | null;
    if (!scroll || !jump) return;
    if (win.state !== 'chat') { jump.hidden = true; return; }
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    jump.hidden = distance < 48 || scroll.scrollHeight <= scroll.clientHeight;
  }

  /** 窗口内的历史会话视图：列出全部会话，点一条在当前窗口打开。 */
  function renderLlmChatHistory(win) {
    const list = win?.historyList as HTMLElement | null;
    if (!list) return;
    const conversations = llmConversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const count = win.historyCount as HTMLElement | null;
    if (count) count.textContent = conversations.length ? t('{n} 条', { n: conversations.length }) : '';
    list.replaceChildren();
    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.className = 'llm-chat-history-empty';
      empty.textContent = t('还没有历史对话。提一个问题，它会出现在这里。');
      list.append(empty);
      return;
    }
    conversations.forEach((conversation) => {
      list.append(createLlmHistoryCard(conversation, () => openLlmConversation(conversation, win)));
    });
  }

  /** 切换窗口的「对话 / 历史」两个视图。 */
  function setLlmChatWindowState(win, state) {
    win.state = state === 'history' ? 'history' : 'chat';
    const inHistory = win.state === 'history';
    const chat = win.root?.querySelector('.llm-chat-scroll') as HTMLElement | null;
    const history = win.root?.querySelector('.llm-chat-history') as HTMLElement | null;
    const compose = win.root?.querySelector('.llm-chat-compose') as HTMLElement | null;
    if (chat) chat.hidden = inHistory;
    if (history) history.hidden = !inHistory;
    // 历史视图里不发送消息，输入区一并收起，避免「看不到对话却能提问」的错位。
    if (compose) compose.hidden = inHistory;
    // 返回键只在历史视图里出现（它是「从历史退回对话」，不是「进入历史」）。
    // 进入历史由独立的 .llm-chat-history-btn 负责，按钮高亮表示当前正处在历史里。
    if (win.back) win.back.hidden = !inHistory;
    if (win.historyButton) win.historyButton.classList.toggle('is-active', inHistory);
    if (win.title) win.title.textContent = inHistory ? t('历史对话') : (shortenLlmText(firstMessage(win.conversation, 'user'), 42) || t('新对话'));
    if (inHistory) renderLlmChatHistory(win);
    updateLlmChatJump(win);
  }

  /** 让某个窗口独占焦点语义：其它窗口的输入框失焦，避免回车发到看不见的窗口里。 */
  function focusLlmChatWindow(win) {
    if (!win) return;
    raiseLlmChatWindow(win);
    if (win.state === 'history') return;
    window.requestAnimationFrame(() => (win.input as HTMLTextAreaElement | null)?.focus({ preventScroll: true }));
  }

  /** 用模板建一个对话窗口并挂进层里。conversation 为空表示开一段新对话。 */
  function createLlmChatWindow(conversation) {
    const template = llmChatWindowTemplate;
    const layer = llmChatLayer as HTMLElement | null;
    if (!template || !layer) return null;
    const root = (template.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement | null;
    if (!root) return null;
    const win: any = {
      root,
      conversation: conversation || null,
      // 几何记忆按会话 id 存；新对话还没 id 时给个临时键，落库后再顶上。
      geometryKey: conversation?.id || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      requestInFlight: false,
      state: 'chat',
      pinned: false,
      scroll: root.querySelector('.llm-chat-scroll'),
      historyList: root.querySelector('.llm-chat-history-list'),
      historyCount: root.querySelector('.llm-chat-history-count'),
      input: root.querySelector('.llm-chat-input'),
      compose: root.querySelector('.llm-chat-compose'),
      title: root.querySelector('.llm-chat-title'),
      subtitle: root.querySelector('.llm-chat-subtitle'),
      back: root.querySelector('.llm-chat-back'),
      historyButton: root.querySelector('.llm-chat-history-btn'),
      pin: root.querySelector('.llm-chat-pin'),
      jump: root.querySelector('.llm-chat-jump')
    };
    // 几何：有会话记忆就恢复，没有就继承全局上次尺寸，再没有才用默认错开位置。
    // 底色是默认布局；真正的记忆由 applyLlmWindowGeometry 在几何表就绪后套上
    // （读盘是异步的，第一个窗口很可能在它之前就建好了）。
    const geoTable = readLlmWindowGeometry();
    const saved = geoTable[win.geometryKey];
    const savedSize = saved || geoTable[LLM_WINDOW_SIZE_KEY];
    const rect = defaultLlmWindowRect();
    root.style.left = `${Number.isFinite(saved?.left) ? saved.left : rect.left}px`;
    root.style.top = `${Number.isFinite(saved?.top) ? saved.top : rect.top}px`;
    root.style.width = `${Number.isFinite(savedSize?.width) ? savedSize.width : rect.width}px`;
    root.style.height = `${Number.isFinite(savedSize?.height) ? savedSize.height : rect.height}px`;
    win.pinned = Boolean(saved?.pinned);
    root.classList.toggle('is-pinned', Boolean(win.pinned));
    win.pin?.setAttribute('aria-pressed', String(Boolean(win.pinned)));
    win.pin?.classList.toggle('is-active', Boolean(win.pinned));
    layer.append(root);
    // 模板里的静态文案带 data-i18n，克隆后要按当前语言刷一次；标题与副标题随后由
    // syncLlmChatWindowChrome 用 t() 覆盖。
    applyI18n(root);
    // 量之前必须让层可见。`hidden` 的容器里 offsetWidth/offsetLeft 恒为 0，
    // 几何会被算成「0×0 放在左上角」，窗口于是缩到最小值并贴到 (0,0)。
    layer.hidden = false;
    layer.setAttribute('aria-hidden', 'false');
    clampLlmWindowRect(root);
    raiseLlmChatWindow(win);
    // 入场动画只放一次：加 .is-entering，动画结束就摘掉。摘掉后这个类不再回来，
    // 于是拖动等后续的类增删不会再触发重放（见 CSS 里 .is-entering 的说明）。
    root.classList.add('is-entering');
    root.addEventListener('animationend', (event) => {
      if (event.animationName === 'quickfind-llm-rise') root.classList.remove('is-entering');
    });
    // 读到几何记忆后回头摆正这个窗口（含置顶）。已经在建前读到就直接命中了。
    void ensureLlmWindowGeometry().then(() => applyLlmWindowGeometry(win));

    attachLlmWindowDrag(win, root.querySelector('.llm-chat-head') as HTMLElement, 'move');
    attachLlmWindowDrag(win, root.querySelector('.llm-chat-resize') as HTMLElement, 'resize');
    win.pin?.addEventListener('click', () => {
      setLlmWindowPinned(win, !win.pinned);
      rememberLlmWindowGeometry(win);
    });
    // 返回键：从历史退回对话。历史入口是独立的按钮（可来回切换）。
    win.back?.addEventListener('click', () => setLlmChatWindowState(win, 'chat'));
    win.historyButton?.addEventListener('click', () => setLlmChatWindowState(win, win.state === 'history' ? 'chat' : 'history'));
    root.querySelector('.llm-chat-close')?.addEventListener('click', () => closeLlmChatWindow(win));
    win.compose?.addEventListener('submit', (event) => { event.preventDefault(); void sendLlmMessageInWindow(win, win.input?.value); });
    win.input?.addEventListener('input', () => resizeLlmTextarea(win.input));
    win.input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void sendLlmMessageInWindow(win, win.input?.value);
    });
    resizeLlmTextarea(win.input);
    win.scroll?.addEventListener('scroll', () => updateLlmChatJump(win), { passive: true });
    win.jump?.addEventListener('click', () => {
      const scroll = win.scroll as HTMLElement | null;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
      updateLlmChatJump(win);
    });
    root.addEventListener('pointerdown', () => raiseLlmChatWindow(win), true);

    llmChatWindows.push(win);
    syncLlmChatWindowChrome(win);
    renderLlmChatWindow(win);
    return win;
  }

  /** 顶部标题与副标题随会话内容刷新。 */
  function syncLlmChatWindowChrome(win) {
    if (!win) return;
    if (win.title && win.state !== 'history') win.title.textContent = shortenLlmText(firstMessage(win.conversation, 'user'), 42) || t('新对话');
    if (win.subtitle) win.subtitle.textContent = t('{n} · 对话中', { n: normalizeLlmConfig(settings?.llm).model || 'LLM' });
  }

  /** 关一个窗口。关掉最后一个时，整层与宿主一并收干净（含 top layer）。 */
  function closeLlmChatWindow(win) {
    const index = llmChatWindows.indexOf(win);
    if (index < 0) return;
    rememberLlmWindowGeometry(win);
    llmChatWindows.splice(index, 1);
    (win.root as HTMLElement | null)?.remove();
    syncLlmChatLayer();
    renderLlmHistory();
  }

  /** 层与宿主的显隐：还有窗口就显示，一个都不剩就收起宿主并收回 top layer。 */
  function syncLlmChatLayer() {
    const layer = llmChatLayer as HTMLElement | null;
    const open = llmChatWindows.length > 0;
    if (layer) {
      layer.hidden = !open;
      layer.setAttribute('aria-hidden', String(!open));
    }
    if (!open && settings.llmDockVisible === false) setLlmDockOpen(false);
    syncLlmDockHostVisibility();
    demoteHostIfIdle();
  }

  function showLlmChatLayer() {
    const layer = llmChatLayer as HTMLElement | null;
    if (!layer) return;
    // 先置层可见再展开宿主：setLlmDockOpen 的「侧栏不可用」闸门认这个状态，
    // 否则在关掉「随心问」的配置下，「问 ai」会被自己的守卫挡回去。
    layer.hidden = false;
    layer.setAttribute('aria-hidden', 'false');
    // 对话窗口是独立面板，**不把右侧栏一起拉出来**：侧栏展开后会占住右边缘
    // （宽 392px 的整高面板），既抢视线，又会吞掉「点窗口外面」的那一下——窗口再也关不掉。
    // 只在「窗口确实要用宿主」这个意义上让宿主可见，侧栏自己的显隐交给开关与滑杆。
    syncLlmDockHostVisibility();
    // 窗口在主宿主里，而页面可能有 z-index 拉满的埋点层压在上面，靠 top layer 才稳。
    promoteToTopLayer(host);
  }

  /** 收起全部对话窗口（Esc、或从侧栏进入大纲时用）。 */
  function hideLlmChatLayer() {
    llmChatWindows.slice().forEach((win) => closeLlmChatWindow(win));
    syncLlmChatLayer();
    if (settings.llmDockVisible === false) return;
    window.requestAnimationFrame(() => (llmSidebarInput as HTMLTextAreaElement | null)?.focus({ preventScroll: true }));
  }

  /**
   * 打开一段会话：同一个会话只占一个窗口——已有窗口就抬起来，没有才新建。
   * 这是「一对话一窗口」的落点，避免反复点历史把屏幕堆满。
   */
  function openLlmConversation(conversation, originWindow) {
    const normalized = normalizeLlmConversation(conversation);
    if (!normalized) return null;
    const current = llmConversations.find((item) => item.id === normalized.id);
    const target = current || normalized;
    if (!current) llmConversations.unshift(target);
    const existing = llmChatWindows.find((win) => win.conversation?.id === target.id);
    if (existing) {
      // 若是在另一个窗口的历史视图里点的，原窗口留着自己的会话，这里只换目标窗口的内容。
      existing.conversation = target;
      setLlmChatWindowState(existing, 'chat');
      syncLlmChatWindowChrome(existing);
      renderLlmChatWindow(existing);
      showLlmChatLayer();
      focusLlmChatWindow(existing);
      if (originWindow && originWindow !== existing && originWindow.state === 'history') setLlmChatWindowState(originWindow, 'chat');
      return existing;
    }
    const win = createLlmChatWindow(target);
    if (!win) return null;
    showLlmChatLayer();
    focusLlmChatWindow(win);
    return win;
  }

  /** 侧栏「新对话」：只清侧栏输入，不碰已打开的窗口。 */
  function startNewLlmConversation() {
    if (!llmSidebarInput) return;
    llmSidebarInput.value = '';
    resizeLlmTextarea(llmSidebarInput);
    renderLlmHistory();
    window.requestAnimationFrame(() => (llmSidebarInput as HTMLTextAreaElement | null)?.focus({ preventScroll: true }));
  }

  function resolveLlmEndpoint(value) {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
    if (/\/v\d+$/i.test(endpoint)) return `${endpoint}/chat/completions`;
    return `${endpoint}/v1/chat/completions`;
  }

  function buildLlmMessages(conversation) {
    const config = normalizeLlmConfig(settings?.llm);
    const messages = [];
    if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
    conversation.messages.forEach((message) => messages.push({ role: message.role, content: message.content }));
    return messages;
  }

  function requestLlmViaFetch(config, messages) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    // 与 background 侧同样加超时：这条路径在 chrome.runtime 不可用时才走，但同样可能挂起，
    // 挂起时窗口的 requestInFlight 不会复位，会话就卡死在「正在思考…」。
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    return fetch(resolveLlmEndpoint(config.endpoint), { method: 'POST', headers, body: JSON.stringify({ model: config.model, messages, temperature: 0.7, stream: false }), signal: controller.signal }).then(async (response) => {
      let payload = null;
      try { payload = await response.json(); } catch { /* retain status-based error */ }
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || t('请求失败（{n}）', { n: response.status }));
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error(t('接口返回了空回复。'));
      return content.trim();
    }).catch((error) => {
      // AbortError 的原生文案（"signal is aborted without reason"）对用户没有意义。
      if (error?.name === 'AbortError') throw new Error(t('请求超时（超过 {n} 秒未响应）。', { n: Math.round(LLM_TIMEOUT_MS / 1000) }));
      throw error;
    }).finally(() => window.clearTimeout(timer));
  }

  function requestLlmResponse(conversation) {
    const config = normalizeLlmConfig(settings?.llm);
    if (!llmHasConfig()) return Promise.reject(new Error(t('请先在设置页填写 API 地址和模型。')));
    const messages = buildLlmMessages(conversation);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: 'quickfind-llm-chat', config, messages, language: getLocale() }, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) { reject(new Error(runtimeError.message || t('无法连接到扩展后台。'))); return; }
            if (!response?.ok) { reject(new Error(response?.error || t('接口请求失败。'))); return; }
            resolve(String(response.content || '').trim());
          });
        } catch (error) { reject(error); }
      });
    }
    return requestLlmViaFetch(config, messages);
  }

  /**
   * 在指定窗口里发一条消息。
   *
   * 请求在飞标志挂在窗口上而不是全局：两个窗口各问各的，互不阻塞——全局标志会让
   * 「第一个窗口还在等回复」变成「第二个窗口发不出去」，而这在多窗口下是常态。
   */
  async function sendLlmMessageInWindow(win, value) {
    const text = String(value || '').trim();
    if (!win || !text || win.requestInFlight) return;
    if (!win.conversation) {
      const now = Date.now();
      win.conversation = { id: `llm-${now}-${Math.random().toString(36).slice(2, 8)}`, messages: [], createdAt: now, updatedAt: now };
      llmConversations.unshift(win.conversation);
    }
    const conversation = win.conversation;
    // 草稿键换成真实会话 id，几何记忆才能跟着会话走。
    if (String(win.geometryKey || '').startsWith('draft-')) win.geometryKey = conversation.id;
    conversation.messages.push({ role: 'user', content: text });
    conversation.updatedAt = Date.now();
    win.requestInFlight = true;
    const input = win.input as HTMLTextAreaElement | null;
    if (input) { input.value = ''; resizeLlmTextarea(input); }
    if (win.state !== 'chat') setLlmChatWindowState(win, 'chat');
    syncLlmChatWindowChrome(win);
    showLlmChatLayer();
    syncLlmConfigStatus('busy');
    renderLlmChatWindow(win);
    renderLlmHistory();
    writeLlmConversations();
    try {
      const content = await requestLlmResponse(conversation);
      conversation.messages.push({ role: 'assistant', content });
      conversation.updatedAt = Date.now();
      syncLlmConfigStatus();
    } catch (error) {
      conversation.messages.push({ role: 'assistant', content: t('请求失败：{n}', { n: error?.message || t('无法连接到 API。') }) });
      conversation.updatedAt = Date.now();
      syncLlmConfigStatus('error');
    } finally {
      win.requestInFlight = false;
      writeLlmConversations();
      renderLlmHistory();
      // 窗口可能在等回复期间被关掉，此时不再操作已摘除的 DOM。
      if (llmChatWindows.includes(win)) {
        renderLlmChatWindow(win);
        syncLlmChatWindowChrome(win);
      }
    }
  }

  /** 侧栏输入框发的消息：没有窗口就开一个，有窗口就投给最上面那个。 */
  function sendLlmMessageFromSidebar(value) {
    const text = String(value || '').trim();
    if (!text || !llmSidebarInput) return;
    const target = llmChatWindows.length ? llmChatWindows[llmChatWindows.length - 1] : createLlmChatWindow(null);
    if (!target) return;
    showLlmChatLayer();
    void sendLlmMessageInWindow(target, text);
    llmSidebarInput.value = '';
    resizeLlmTextarea(llmSidebarInput);
  }

  // 键名来自 shared/notes.ts：三个入口读写的是同一份笔记，字面量各写一份迟早写错一处。
  const NOTES_KEY = NOTES_STORAGE_KEY;
  const NOTES_LEGACY_KEY = LEGACY_NOTES_STORAGE_KEY;
  const OUTLINE_TAB_KEY = 'quickfind-outline-tab';
  const OUTLINE_TITLES = { chat: t('随心问'), outline: t('无限大纲笔记') };
  const NOTES_HISTORY_LIMIT = 100;
  let notesState = createEmptyNotes();
  let notesLoaded = false;
  /** 首次读盘的进度：null 表示还没开始读，写完才 resolve。往笔记里写东西前先等它。 */
  let notesLoadPromise: Promise<void> | null = null;
  let notesSaveTimer = null;
  let notesSearchTimer = null;
  let notesActiveId = null;
  let notesZoomRootId = 'root';
  let notesFocusRestoreToken = 0;
  let notesUndoStack = [];
  let notesRedoStack = [];
  let notesTypingHistoryId = null;
  let notesTypingBeforeState = null;
  let notesHistorySuspend = false;
  let noteIdCounter = 0;
  let llmActiveTab = 'chat';

  // 空状态与归一化都在 shared/outline.ts，这里的名字只是本文件内的短别名。
  function createEmptyNotes() { return outlineCreateEmptyNotes(); }
  function normalizeNotes(raw) { return outlineNormalizeNotes(raw); }

  function noteId() { noteIdCounter += 1; return 'note-' + Date.now() + '-' + noteIdCounter; }
  function cloneNotesState(state = notesState) { return JSON.parse(JSON.stringify(state)); }
  function notesStateSignature(state = notesState) { return JSON.stringify({ rootId: state.rootId, nodes: state.nodes }); }

  function readNotesStorage(): Promise<{ current: any; legacy: any }> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      return new Promise((resolve) => chrome.storage.local.get([NOTES_KEY,
      NOTES_LEGACY_KEY], (stored) => resolve({ current: stored?.[NOTES_KEY] || null, legacy: stored?.[NOTES_LEGACY_KEY] || null })));
    }
    try {
      return Promise.resolve({ current: JSON.parse(localStorage.getItem(NOTES_KEY) || 'null'), legacy: JSON.parse(localStorage.getItem(NOTES_LEGACY_KEY) || 'null') });
    } catch { return Promise.resolve({ current: null, legacy: null }); }
  }

  function writeNotesStorage() {
    // 刷新 updatedAt：设置页用它判断哪一份副本更新，侧栏若沿用旧时间戳，
    // 在设置页里做的合并会判定侧栏数据更旧，从而把这里的修改覆盖掉。
    notesState.updatedAt = Date.now();
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) { chrome.storage.local.set({ [NOTES_KEY]: notesState }); return; }
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notesState)); } catch { /* storage may be unavailable */ }
  }

  function scheduleNotesSave() {
    if (notesSaveTimer) window.clearTimeout(notesSaveTimer);
    notesSaveTimer = window.setTimeout(() => { notesSaveTimer = null; writeNotesStorage(); }, 350);
  }

  function removeLegacyNotesStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) { chrome.storage.local.remove(NOTES_LEGACY_KEY); return; }
    try { localStorage.removeItem(NOTES_LEGACY_KEY); } catch { /* ignore */ }
  }

  // 旧版侧栏笔记（多笔记 + 嵌套树）迁移为与设置页一致的扁平节点树。
  function legacyNotesToState(legacyNotes) {
    const state = createEmptyNotes();
    const now = Date.now();
    (Array.isArray(legacyNotes) ? legacyNotes : []).forEach((note, index) => {
      const title = String(note?.title || '').trim() || t('未命名笔记 {n}', { n: index + 1 });
      const item = { id: noteId(), parentId: 'root', children: [], text: title, collapsed: false, completed: false, createdAt: now, updatedAt: now };
      state.nodes[item.id] = item;
      state.nodes.root.children.push(item.id);
      const walk = (nodes, parentId) => {
        (Array.isArray(nodes) ? nodes : []).forEach((value) => {
          if (!value || typeof value !== 'object') return;
          const child = { id: noteId(), parentId, children: [], text: String(value.text ?? '').trim(), collapsed: value.collapsed === true, completed: false, createdAt: now, updatedAt: now };
          state.nodes[child.id] = child;
          state.nodes[parentId].children.push(child.id);
          walk(value.children, child.id);
        });
      };
      walk(note?.nodes, item.id);
    });
    return state;
  }

  function loadOutlineNotes(): Promise<void> {
    if (notesLoadPromise) { renderNotes(); return notesLoadPromise; }
    notesLoaded = true;
    notesLoadPromise = readNotesStorage().then(({ current, legacy }): void => {
      let state = current ? normalizeNotes(current) : null;
      let migrated = false;
      if (!state && Array.isArray(legacy) && legacy.length) {
        state = legacyNotesToState(legacy);
        migrated = true;
      }
      notesState = state || createEmptyNotes();
      if (migrated) { writeNotesStorage(); removeLegacyNotesStorage(); }
      renderNotes();
      syncOutlineInsertButton();
    });
    return notesLoadPromise;
  }

  /**
   * 等首次读盘落地。侧栏停在「随心问」时笔记还没读过，此时直接写入会把还没读出来的
   * 旧内容当成空笔记覆盖掉——凡是往笔记里写东西的入口都要先走这里。
   */
  function whenNotesReady(): Promise<void> {
    return notesLoadPromise || loadOutlineNotes();
  }

  // 与设置页（及其他标签页侧栏）通过 chrome.storage.local 双向同步。
  function handleNotesStorageChange(changes, areaName) {
    if (areaName !== 'local' || !changes || !changes[NOTES_KEY]) return;
    if (!notesLoaded || notesSaveTimer) return; // 有未保存的本地编辑时跳过，避免覆盖正在输入的内容
    const incoming = changes[NOTES_KEY].newValue;
    if (!incoming || typeof incoming !== 'object') return;
    // 先按 updatedAt 认领「这次变动是不是我自己写出去的」。
    // 自己写的同时也会收到 onChanged，若不短路就要白跑一遍 normalizeNotes（全量遍历+重建树）
    // 再 JSON.stringify 比对签名——节点越多、开的标签页越多，这份浪费越大。
    // writeNotesStorage 里 updatedAt 每次取 Date.now()，单调递增，所以相等即同一份。
    if (Number(incoming.updatedAt) === Number(notesState.updatedAt)) return;
    const next = normalizeNotes(incoming);
    if (notesStateSignature(next) === notesStateSignature()) return;
    notesState = next;
    if (!noteById(notesZoomRootId)) notesZoomRootId = 'root';
    if (notesActiveId && !noteById(notesActiveId)) notesActiveId = null;
    notesUndoStack = [];
    notesRedoStack = [];
    updateNotesHistoryButtons();
    renderNotes();
  }

  function updateNotesHistoryButtons() {
    if (outlineUndoButton) outlineUndoButton.disabled = notesUndoStack.length === 0;
    if (outlineRedoButton) outlineRedoButton.disabled = notesRedoStack.length === 0;
  }

  function pushNotesHistory(before) {
    if (notesHistorySuspend || notesStateSignature(before) === notesStateSignature()) return;
    notesUndoStack.push(before);
    if (notesUndoStack.length > NOTES_HISTORY_LIMIT) notesUndoStack.shift();
    notesRedoStack = [];
    updateNotesHistoryButtons();
  }

  function beginNotesHistory(id) {
    if (notesTypingHistoryId === id) return;
    notesTypingHistoryId = id;
    pushNotesHistory(notesTypingBeforeState || cloneNotesState());
    notesTypingBeforeState = null;
  }

  function restoreNotesSnapshot(snapshot, focusId = null) {
    if (!snapshot) return;
    notesHistorySuspend = true;
    notesState = normalizeNotes(snapshot);
    notesHistorySuspend = false;
    notesActiveId = focusId && noteById(focusId) ? focusId : null;
    if (!noteById(notesZoomRootId)) notesZoomRootId = 'root';
    scheduleNotesSave();
    renderNotes(notesActiveId);
    updateNotesHistoryButtons();
  }

  function undoNotes() {
    const previous = notesUndoStack.pop();
    if (!previous) return;
    notesRedoStack.push(cloneNotesState());
    restoreNotesSnapshot(previous);
  }

  function redoNotes() {
    const next = notesRedoStack.pop();
    if (!next) return;
    notesUndoStack.push(cloneNotesState());
    restoreNotesSnapshot(next);
  }

  // 大纲的查询与树算法全部来自 shared/outline.ts，这里只把 state 传进去。
  function noteById(id) { return outlineNoteById(notesState, id); }
  function noteDepth(id, baseId = 'root') { return outlineNoteDepth(notesState, id, baseId); }
  function notePath(id) { return outlineNotePath(notesState, id); }
  function isNoteDescendant(candidateId, ancestorId) { return outlineIsNoteDescendant(notesState, candidateId, ancestorId); }
  function visibleNoteIds(query) { return outlineVisibleNoteIds(notesState, notesZoomRootId, query); }

  function resizeNoteInput(input) { input.style.height = 'auto'; input.style.height = Math.max(24, input.scrollHeight) + 'px'; }
  function noteSelection(input) { return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }; }
  function focusNote(id, selection = null) {
    const input = outlineList?.querySelector('.note-input[data-note-id="' + CSS.escape(String(id)) + '"]');
    if (!input) return;
    input.scrollIntoView({ block: 'nearest' });
    input.focus({ preventScroll: true });
    const start = Math.max(0, Math.min(input.value.length, Number(selection?.start ?? input.value.length)));
    const end = Math.max(start, Math.min(input.value.length, Number(selection?.end ?? start)));
    input.setSelectionRange(start, end, selection?.direction || 'none');
  }

  /**
   * 大纲圆点上的长按拖动。单击圆点进入专注由圆点自己的 click 处理（见 renderNotes），
   * 这里只接管长按之后那一段：跟随指针的浮层、投放区高亮、松手后的移动。
   */
  const noteDrag = createNoteDrag({
    hitRoot: () => shadow,
    overlayRoot: () => shadow,
    scrollContainer: () => shadow.querySelector('.outline-scroll') as HTMLElement | null,
    ghostText: (id) => String(noteById(id)?.text || '').trim() || t('未命名项目'),
    canDropOn: (sourceId, targetId) => targetId !== sourceId && !isNoteDescendant(targetId, sourceId),
    onDrop: (sourceId, targetId, zone) => moveNote(sourceId, targetId, zone)
  });

  function renderNotes(focusId = null, focusSelection = null) {
    if (!outlineList) return;
    if (!notesLoaded) { outlineList.textContent = t('正在加载笔记…'); return; }
    const focusRestoreToken = ++notesFocusRestoreToken;
    // Rebuilding the list replaces the textarea, so carry its selection across the render.
    let selection = focusSelection;
    const activeInput = shadow.activeElement?.matches?.('.note-input') ? shadow.activeElement : null;
    if (!focusId && activeInput?.dataset.noteId) {
      focusId = activeInput.dataset.noteId;
      selection = noteSelection(activeInput);
    } else if (focusId && !selection && activeInput?.dataset.noteId === String(focusId)) {
      selection = noteSelection(activeInput);
    }
    const query = String(outlineSearchInput?.value || '').trim().toLocaleLowerCase();
    const visible = visibleNoteIds(query);
    outlineList.classList.toggle('zoomed', visible.scopeRoot?.id !== 'root');
    outlineList.replaceChildren();
    if (outlineSearchResult) {
      const matchCount = query ? outlineCountMatches(notesState, notesZoomRootId, query) : 0;
      outlineSearchResult.textContent = query ? t('找到 {n} 项', { n: matchCount }) : '';
    }
    if (visible.scopeRoot && visible.scopeRoot.id !== 'root') {
      const heading = document.createElement('div');
      heading.className = 'notes-zoom-heading';
      heading.textContent = visible.scopeRoot.text.trim() || t('未命名项目');
      outlineList.append(heading);
    }
    if (!visible.ids.length) {
      const empty = document.createElement('div');
      empty.className = 'notes-empty';
      empty.textContent = query ? t('没有匹配的笔记') : (visible.scopeRoot?.id === 'root' ? t('还没有笔记项目，点击“新建”开始。') : t('这个项目还没有子项目，按 Enter 新建。'));
      outlineList.append(empty);
    } else {
      // 先把整表建在 DocumentFragment 里，最后一次性挂上。
      //
      // 原先是「append 一行 → 立刻量这行的高度」，而量高度读的是 scrollHeight：
      // 每读一次都要把「已挂上去的全部行」重排一遍，于是挂 n 行就是 n 次强制布局，
      // 代价随行数平方增长。笔记的定位是无限大纲，行数只会多不会少。
      const fragment = document.createDocumentFragment();
      const inputs: HTMLTextAreaElement[] = [];
      visible.ids.forEach((id) => {
        const node = noteById(id);
        // 深度只算一次：它沿 parentId 向上走，原先每行要算两遍（aria-level 与缩进各一遍）。
        const depth = noteDepth(id, visible.scopeRoot?.id || 'root');
        const row = document.createElement('div');
        row.className = 'note-row' + (node.completed ? ' completed' : '') + (query && node.text.toLocaleLowerCase().includes(query) ? ' search-match' : '');
        row.dataset.noteId = id;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-expanded', node.children.length ? String(!node.collapsed) : 'false');
        row.style.paddingLeft = (6 + depth * 18) + 'px';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'note-toggle' + (node.collapsed ? ' collapsed' : '');
        toggle.disabled = !node.children.length;
        toggle.setAttribute('aria-label', node.children.length ? (node.collapsed ? t('展开项目') : t('收起项目')) : t('没有子项目'));
        toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 6 5-6"></path></svg>';
        toggle.addEventListener('click', () => { if (!node.children.length) return;
        const before = cloneNotesState(); node.collapsed = !node.collapsed; pushNotesHistory(before); node.updatedAt = Date.now(); scheduleNotesSave(); renderNotes(id); });
        const complete = document.createElement('button');
        complete.type = 'button';
        complete.className = 'note-complete';
        complete.setAttribute('aria-label', node.completed ? t('标记未完成') : t('标记完成'));
        complete.title = node.completed ? t('标记未完成') : t('标记完成');
        complete.innerHTML = node.completed ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle></svg>';
        complete.addEventListener('click', () => { const before = cloneNotesState();
        node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id); });
        const bullet = document.createElement('button');
        bullet.type = 'button';
        bullet.className = 'note-bullet';
        bullet.setAttribute('aria-label', t('专注此项目'));
        const input = document.createElement('textarea');
        input.className = 'note-input';
        input.rows = 1;
        input.value = node.text;
        input.setAttribute('aria-label', t('大纲项目'));
        input.dataset.noteId = id;
        input.addEventListener('input', () => { beginNotesHistory(id); node.text = input.value; node.updatedAt = Date.now(); resizeNoteInput(input); updateNotesBreadcrumb(id); scheduleNotesSave(); });
        input.addEventListener('focus', () => { notesActiveId = id; notesTypingHistoryId = null; notesTypingBeforeState = cloneNotesState(); updateNotesBreadcrumb(id); });
        input.addEventListener('keydown', (event) => handleNoteKeydown(event, id, input));
        row.append(toggle, complete, bullet, input);
        // 圆点：单击进入专注，按住不动才进入拖动。见 shared/note-drag.ts。
        bullet.addEventListener('pointerdown', (event) => noteDrag.press(event, id, row, bullet));
        bullet.addEventListener('click', () => { if (noteDrag.shouldIgnoreClick()) return; zoomIntoNote(id); });
        fragment.append(row);
        inputs.push(input);
      });
      // 用 append 而不是 replaceChildren：上面可能已经插入了专注视图的标题行，
      // replaceChildren 会把它一起清掉（列表开头已经 replaceChildren 过，这里只做追加）。
      outlineList.append(fragment);
      // 自适应高度统一放到挂载之后、且按「先全部写、再全部读、最后再全部写」三段走：
      // 中间那次读会触发唯一一次布局，后面的读都命中缓存。逐行「写→读」的话，
      // 每行都会把整表重排一遍。
      inputs.forEach((input) => { input.style.height = 'auto'; });
      const heights = inputs.map((input) => Math.max(24, input.scrollHeight));
      inputs.forEach((input, index) => { input.style.height = heights[index] + 'px'; });
    }
    updateNotesBreadcrumb(notesActiveId);
    if (focusId) {
      focusNote(focusId, selection);
      window.requestAnimationFrame(() => {
        if (focusRestoreToken !== notesFocusRestoreToken) return;
        const current = shadow.activeElement;
        if (!current || !outlineList.contains(current)) focusNote(focusId, selection);
      });
    }
  }

  function updateNotesBreadcrumb(id) {
    if (!outlineBreadcrumb) return;
    const zoomPath = notePath(notesZoomRootId);
    const path = notesZoomRootId !== 'root' ? zoomPath : notePath(id || notesActiveId);
    outlineBreadcrumb.textContent = path.length ? path.join(' / ') : t('根目录');
    if (outlineHomeButton) {
      const atRoot = notesZoomRootId === 'root';
      outlineHomeButton.textContent = atRoot ? t('根目录') : t('返回上级');
      outlineHomeButton.setAttribute('aria-label', atRoot ? t('返回根目录') : t('返回上级'));
      outlineHomeButton.title = atRoot ? t('返回根目录') : t('返回上级');
    }
  }

  function zoomIntoNote(id) {
    const node = noteById(id); if (!node) return;
    notesZoomRootId = node.id; notesActiveId = node.id;
    if (outlineSearchInput) outlineSearchInput.value = '';
    renderNotes(); updateNotesBreadcrumb(id);
  }

  function zoomOutNotes() {
    const node = noteById(notesZoomRootId);
    notesZoomRootId = node?.parentId && noteById(node.parentId) ? node.parentId : 'root';
    notesActiveId = notesZoomRootId === 'root' ? null : notesZoomRootId;
    renderNotes(); updateNotesBreadcrumb(notesActiveId);
  }

  // 以下都是对 shared/outline.ts 的封装：模型层只回答「改成什么样、该聚焦谁」，
// 宿主负责撤销栈、落盘与重绘。这样同一套树算法只有一个实现（见 shared/outline.ts 头部说明）。
  function moveNote(sourceId, targetId, placement = 'after') {
    const before = cloneNotesState();
    const result = outlineMoveNote(notesState, sourceId, targetId, placement);
    if (!result.changed) return;
    pushNotesHistory(before); notesActiveId = result.focusId; scheduleNotesSave(); renderNotes(result.focusId);
  }

  function insertNoteAfter(id, text = '', historyBefore = null) {
    const before = historyBefore || cloneNotesState();
    const result = outlineInsertNoteAfter(notesState, id, text, noteId());
    if (!result.changed) return null;
    notesActiveId = result.focusId;
    pushNotesHistory(before);
    scheduleNotesSave();
    renderNotes(result.focusId);
    return noteById(result.focusId);
  }

  function insertNoteChild(parentId, text = '') {
    const before = cloneNotesState();
    const result = outlineInsertNoteChild(notesState, parentId, text, noteId());
    if (!result.changed) return null;
    notesActiveId = result.focusId;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(result.focusId);
    return noteById(result.focusId);
  }

  function removeNote(id) {
    const before = cloneNotesState();
    const result = outlineRemoveNote(notesState, id);
    if (!result.changed) return null;
    pushNotesHistory(before);
    notesActiveId = result.focusId;
    scheduleNotesSave();
    renderNotes(result.focusId);
    return result.focusId || 'root';
  }

  function changeNoteIndent(id, outdent, input = null) {
    const before = cloneNotesState();
    const result = outlineChangeNoteIndent(notesState, id, outdent);
    if (!result.changed) return;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, input ? noteSelection(input) : null);
  }

  function mergeNoteWithPrevious(id, input) {
    const before = cloneNotesState();
    const result = outlineMergeNoteWithPrevious(notesState, id);
    if (!result.changed) return false;
    pushNotesHistory(before);
    notesActiveId = result.focusId;
    scheduleNotesSave();
    renderNotes(result.focusId, { start: result.caret, end: result.caret });
    return true;
  }

  function handleNoteKeydown(event, id, input) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoNotes() : undoNotes(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redoNotes(); return; }
    if (event.key === 'Escape') { if (notesZoomRootId !== 'root') { event.preventDefault();
    zoomOutNotes(); } else if (outlineSearchInput?.value) { outlineSearchInput.value = ''; renderNotes(id); } return; }
    if (modifier && event.key === 'Enter') { event.preventDefault();
    const node = noteById(id); if (!node) return; const before = cloneNotesState();
    node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, noteSelection(input)); return; }
    if (modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); changeNoteIndent(id, event.key === 'ArrowLeft', input); return; }
    if (modifier && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); const node = noteById(id); const parent = node && noteById(node.parentId);
      const index = parent?.children.indexOf(id) ?? -1; const targetId = parent?.children[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (targetId) moveNote(id, targetId, event.key === 'ArrowUp' ? 'before' : 'after'); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault();
    const cursor = input.selectionStart; const beforeText = input.value.slice(0, cursor);
    const after = input.value.slice(input.selectionEnd); const node = noteById(id);
    const beforeState = cloneNotesState(); if (node) node.text = beforeText; insertNoteAfter(id, after, beforeState); return; }
    if (event.key === 'Tab') { event.preventDefault(); changeNoteIndent(id, event.shiftKey, input); return; }
    if (event.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); if (input.value) mergeNoteWithPrevious(id, input); else removeNote(id); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { const inputs = Array.from(outlineList.querySelectorAll('.note-input'));
    const index = inputs.indexOf(input); const next = inputs[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (next && (event.key === 'ArrowUp' ? input.selectionStart === 0 : input.selectionStart === input.value.length)) { event.preventDefault();
    next.focus(); next.setSelectionRange(event.key === 'ArrowUp' ? next.value.length : 0, event.key === 'ArrowUp' ? next.value.length : 0); } }
  }

  function addNote() {
    if (!notesLoaded) return;
    const target = notesActiveId && noteById(notesActiveId) ? notesActiveId : null;
    if (target && notesZoomRootId !== 'root' && target === notesZoomRootId) return insertNoteChild(target);
    if (target) return insertNoteAfter(target);
    const before = cloneNotesState();
    const result = outlineInsertNoteChild(notesState, notesZoomRootId, '', noteId());
    if (!result.changed) return;
    notesActiveId = result.focusId;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(result.focusId);
  }

  function setAllNotesCollapsed(collapsed) {
    if (!notesLoaded) return;
    const before = cloneNotesState();
    outlineSetAllNotesCollapsed(notesState, collapsed);
    pushNotesHistory(before); scheduleNotesSave(); renderNotes();
  }

  function syncOutlineInsertButton() {
    if (!outlineInsertSelection) return;
    const hasText = Boolean(String(selectedText || '').trim());
    outlineInsertSelection.disabled = !hasText;
    outlineInsertSelection.title = hasText ? t('把页面上选中的文字加入笔记') : t('先在页面上选中一段文字');
  }

  /**
   * 把一段文字按行写进大纲笔记，返回是否写入。
   * atTop 为真时落在当前层级的第一行（特殊功能按钮「笔记」用），否则跟随插入点
   * （侧栏「插入」按钮原来的行为）。调用前先等 whenNotesReady()。
   */
  function appendTextToOutlineNotes(raw: unknown, atTop: boolean): boolean {
    if (!notesLoaded) return false;
    const text = String(raw ?? '').trim();
    if (!text) return false;
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 60);
    if (!lines.length) return false;
    const scopeRoot = noteById(notesZoomRootId) || noteById('root');
    if (!scopeRoot) return false;
    const before = cloneNotesState();
    const now = Date.now();
    const created = lines.map((line) => ({ id: noteId(), parentId: String(scopeRoot.id), children: [] as string[], text: line, collapsed: false, completed: false, createdAt: now, updatedAt: now }));
    // notesState.nodes 的类型是按空状态推断出来的，按 id 写入需要一层显式视图。
    const nodes: Record<string, (typeof created)[number]> = notesState.nodes;
    created.forEach((node) => { nodes[node.id] = node; });
    const ids = created.map((node) => node.id);
    const anchor = atTop ? null : (notesActiveId && noteById(notesActiveId) ? notesActiveId : null);
    const parent = anchor ? noteById(anchor.parentId) || scopeRoot : scopeRoot;
    created.forEach((node) => { node.parentId = String(parent.id); });
    if (anchor) parent.children.splice(parent.children.indexOf(anchor) + 1, 0, ...ids);
    else if (atTop) parent.children.unshift(...ids);
    else parent.children.push(...ids);
    parent.collapsed = false;
    notesActiveId = ids[0];
    pushNotesHistory(before);
    scheduleNotesSave();
    renderNotes(ids[0]);
    return true;
  }

  function insertSelectionIntoNotes() {
    void whenNotesReady().then(() => { appendTextToOutlineNotes(selectedText, false); });
  }

  /** 特殊功能按钮「笔记」：把内容存到笔记第一行，并把结果显示出来。返回值只表示已受理。 */
  function saveTextToOutlineNotes(raw: unknown): boolean {
    const text = String(raw ?? '').trim();
    if (!text) return false;
    void whenNotesReady().then(() => { if (appendTextToOutlineNotes(text, true)) showOutlineNotes(); });
    return true;
  }

  /** 存完之后把结果摆到眼前：切到大纲页并展开侧栏；选项页把侧栏整个关掉时不打扰。 */
  function showOutlineNotes(): void {
    // 笔记模块已下线：没有可展开的侧栏页，也不必再切标签。
    if (!OUTLINE_NOTES_ENABLED) return;
    if (!llmDock || (llmDock as HTMLElement).hidden) return;
    if (llmActiveTab !== 'outline') setLlmTab('outline');
    // 用户点了「笔记」按钮才有这次展示，按主动展开处理，别让它随即被自动收起。
    setLlmDockOpen(true, { pinned: true });
  }

  /**
   * 特殊功能按钮「问 ai」：弹出一个新的对话窗口，把搜索框里的内容作为首个问题发出去。
   *
   * 复用既有的对话层与会话存储（quickfind-llm-conversations），不新建第二套对话 UI。
   * 每次点开**新开一个窗口**：搜索框这句话是要问的题目，接在上一段对话后面说不通；
   * 用户想回看旧会话，走窗口里的历史入口（同一个会话只占一个窗口）。
   * 没有查询词时只开一个空窗口，让用户自己起题。
   */
  function askAiFromAction(raw: unknown): boolean {
    const text = String(raw ?? '').trim();
    if (!llmChatLayer) return false;
    const win = createLlmChatWindow(null);
    if (!win) return false;
    syncLlmConfigStatus();
    // 先把窗口亮出来：sendLlmMessageInWindow 在「该窗口上一条还在飞」时会提前返回，
    // 若只靠它来展示，用户就会看到「点了没反应」。
    showLlmChatLayer();
    if (text) void sendLlmMessageInWindow(win, text);
    // 无论有没有带上问题，都把光标放到追问输入框，用户接着问不用再点一次。
    focusLlmChatWindow(win);
    return true;
  }

  function setLlmTab(tab, options = {}) {
    const next = tab === 'outline' ? 'outline' : 'chat';
    llmActiveTab = next;
    llmTabbar?.querySelectorAll('.llm-tab').forEach((button) => {
      const active = button.dataset.tab === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    shadow.querySelectorAll('.llm-pane').forEach((pane) => { pane.hidden = pane.dataset.pane !== next; });
    if (llmTitle) llmTitle.textContent = OUTLINE_TITLES[next];
    if (next === 'outline') loadOutlineNotes();
    else renderLlmHistory();
    syncOutlineInsertButton();
    if (options.persist !== false && typeof chrome !== 'undefined' && chrome.storage?.local?.set) chrome.storage.local.set({ [OUTLINE_TAB_KEY]: next });
  }

  function initializeLlmDock() {
    if (!llmDock || initializeLlmDock.started) return;
    initializeLlmDock.started = true;
    // 侧栏只由「点击」打开。此前是 pointerenter / focus / focusin 都会展开，
    // 于是鼠标扫过右边缘、或页面把焦点落到滑杆上（按钮天然可聚焦）时，一整个面板
    // 会自己滑出来——用户看到的就是「莫名奇妙自动展开」，且没有任何操作能预期到它。
    // 收起路径保持不变（指针离开、关闭按钮、Esc），只有「显示」需要用户明确动作。
    llmRail?.addEventListener('pointerleave', scheduleLlmDockClose);
    llmSidebar?.addEventListener('pointerleave', scheduleLlmDockClose);
    llmRail?.addEventListener('click', () => setLlmDockOpen(!llmDockOpen, { pinned: true }));
    llmSidebarClose?.addEventListener('click', () => setLlmDockOpen(false));
    llmNewChat?.addEventListener('click', startNewLlmConversation);
    llmSidebarCompose?.addEventListener('submit', (event) => { event.preventDefault(); sendLlmMessageFromSidebar(llmSidebarInput.value); });
    // 每个窗口自己绑定拖动/缩放/按钮（见 createLlmChatWindow），这里只处理全局的指针与键盘。
    window.addEventListener('pointermove', (event) => {
      // 有对话窗口开着时不自动收侧栏：窗口可能正被拖动，收起侧栏会让层高变化、手感发飘。
      if (!llmDock.classList.contains('is-open') || llmChatWindows.length) return;
      const pointInside = (rect) => rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      const railRect = llmRail?.getBoundingClientRect();
      const sidebarRect = llmSidebar?.getBoundingClientRect();
      if (pointInside(railRect) || pointInside(sidebarRect)) {
        if (llmCloseTimer) { window.clearTimeout(llmCloseTimer); llmCloseTimer = null; }
      } else scheduleLlmDockClose();
    }, true);
    [llmSidebarInput].filter(Boolean).forEach((input) => {
      input.addEventListener('input', () => resizeLlmTextarea(input));
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        input.form?.requestSubmit();
      });
      resizeLlmTextarea(input);
    });
    document.addEventListener('keydown', (event) => {
      // Esc 关掉最上面那个窗口；全关完了才轮到侧栏。一次性全关在多窗口下太粗暴。
      if (event.key !== 'Escape' || !llmChatWindows.length) return;
      event.preventDefault();
      closeLlmChatWindow(llmChatWindows[llmChatWindows.length - 1]);
    }, true);
    /**
     * 点窗口以外的地方 → 收起**未置顶**的窗口。
     *
     * 用 `pointerdown` 而不是 `click`：窗口里按下、拖到窗口外松手（正是拖动窗口的操作）
     * 在 `click` 阶段会命中「外面」，用 click 判定就会把正在拖的窗口关掉。
     * 置顶窗口不受影响——那正是「置顶」的语义：钉住不被点走。
     */
    document.addEventListener('pointerdown', (event) => {
      if (!llmChatWindows.length) return;
      // 点在扩展自己的界面里（任一窗口、侧栏、浮层）就不算「外面」。
      if (eventInsideOverlay(event)) return;
      llmChatWindows.slice().forEach((win) => { if (!win.pinned) closeLlmChatWindow(win); });
    }, true);
    llmTabbar?.addEventListener('click', (event) => {
      const button = event.target?.closest?.('.llm-tab');
      if (button) setLlmTab(button.dataset.tab);
    });
    outlineAddButton?.addEventListener('click', addNote);
    outlineUndoButton?.addEventListener('click', undoNotes);
    outlineRedoButton?.addEventListener('click', redoNotes);
    outlineExpandButton?.addEventListener('click', () => setAllNotesCollapsed(false));
    outlineCollapseButton?.addEventListener('click', () => setAllNotesCollapsed(true));
    outlineHomeButton?.addEventListener('click', () => {
      if (notesZoomRootId === 'root') { if (outlineSearchInput) outlineSearchInput.value = ''; renderNotes(); }
      else zoomOutNotes();
    });
    outlineInsertSelection?.addEventListener('click', insertSelectionIntoNotes);
    outlineSearchInput?.addEventListener('input', () => {
      window.clearTimeout(notesSearchTimer);
      notesSearchTimer = window.setTimeout(() => renderNotes(), 120);
    });
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.addListener(handleNotesStorageChange);
    document.addEventListener('selectionchange', syncOutlineInsertButton);
    if (PAGE_SIDEBAR_ENABLED && typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(OUTLINE_TAB_KEY, (stored) => setLlmTab(stored?.[OUTLINE_TAB_KEY] === 'outline' ? 'outline' : 'chat', { persist: false }));
    } else setLlmTab('chat', { persist: false });
    loadLlmConversations();
    syncLlmConfigStatus();
    // 先把窗口几何记忆读进来。窗口是同步建的，读盘是异步的——在这里提前起跑，
    // 用户点「问 ai」时记忆多半已就绪，不必等异步回来再摆一次。
    void ensureLlmWindowGeometry();
  }

  function storageAvailable() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  function eventInsideOverlay(event) {
    return (typeof event.composedPath === 'function' && event.composedPath().includes(host)) || host.contains(event.target);
  }

  // 会与页面快捷键冲突的编辑键。视频站（B 站、YouTube 等）用空格做播放/暂停、
  // 用方向键做快进/音量，而扩展输入框里这些键应该是纯编辑操作。
  const OVERLAY_EDIT_KEYS = new Set([' ', 'Spacebar', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

  /**
   * 扩展输入框的按键隔断。
   *
   * 视频站的通用判法是「document 捕获阶段监听 keydown，target 是 INPUT/TEXTAREA
   * 就放行」——借此区分「在搜索框打字」与「全站快捷键」。扩展的输入框在 shadow DOM 里，
   * 页面侧看到的 event.target 被重定向成宿主 <div>，那条判定失效，空格于是被当成
   * 播放/暂停：在扩展输入框里打字会暂停视频。
   *
   * 判定不能只看某一个输入框。此前只认选区浮层的 queryInput，而常驻搜索栏与 LLM 侧栏
   * 各自是独立 shadow root，它们的按键全部漏给了页面。改为看整条事件路径：只要经过
   * 某个扩展宿主、且路径里确实有可编辑元素，就把编辑键拦在扩展内部。
   * 只拦编辑键，其余按键照常外传，不影响页面自身的键盘操作。
   */
  function keepPanelSearchKeysInOverlay(event) {
    if (!OVERLAY_EDIT_KEYS.has(event.key) && event.code !== 'Space') return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.length) return;
    // 按 id 取常驻栏宿主，而不是引用模块级变量：那个变量由 `let = null` 声明，
    // 每引用一次就记一个隐式 any，会给类型债务加数（见 README 的记账口径）。
    if (!path.some((node: any) => node === host || node?.id === 'quickfind-pinned-search-host')) return;
    // 用 nodeType/tagName 判定而不依赖跨世界 instanceof：content script 在隔离世界运行，
    // 从页面侧拿到的元素对象其原型链与本世界不同。isContentEditable 只有 HTMLElement 有，
    // 所以先按 nodeType 收窄，再读属性。
    const editing = path.some((node: any) => node && node.nodeType === 1 &&
      (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable === true));
    if (!editing) return;
    // 输入框的原生编辑行为（插入空格、移动光标）不依赖 window 上的监听器，
    // 所以这里只阻断页面侧的快捷键，输入本身不受影响。
    event.stopImmediatePropagation();
  }

  ['keydown', 'keyup', 'keypress'].forEach((type) => {
    window.addEventListener(type, keepPanelSearchKeysInOverlay, true);
  });

  /**
   * 语言切换的唯一生效点（页面侧）。
   *
   * 静态模板带 data-i18n，交给 applyI18n；动态文案（引擎按钮、常驻栏、历史卡片、
   * 对话窗口）必须重画——它们的内容是渲染时拼出来的。
   */
  function applyInterfaceLanguage() {
    setLocale(settings?.language);
    applyI18n(shadow);
    if (pinnedHost?.shadowRoot) applyI18n(pinnedHost.shadowRoot);
    syncLlmConfigStatus();
    renderLlmHistory();
    llmChatWindows.forEach((win) => {
      if (win.state === 'history') renderLlmChatHistory(win);
      // 标题也要按当前视图重算：历史视图里它显示「历史对话」，不能被 data-i18n 的
      // 「新对话」覆盖掉。
      if (win.title) win.title.textContent = win.state === 'history'
        ? t('历史对话')
        : (shortenLlmText(firstMessage(win.conversation, 'user'), 42) || t('新对话'));
      if (win.subtitle) win.subtitle.textContent = t('{n} · 对话中', { n: normalizeLlmConfig(settings?.llm).model || 'LLM' });
      if (win.scroll) renderLlmChatWindow(win);
    });
    if (panelOpen) renderEngines();
    // 这两处标题由状态决定，data-i18n 只会写静态版本，切语言后要按当前状态补一次。
    queryExpand.title = t(expanded ? '收起多行输入' : '展开多行输入');
    syncOutlineInsertButton();
    syncPinnedOpenModeButton();
    mountPinnedBar();
  }

  function loadSettings() {
    // 没有 storage 就没有真实配置可等，直接放行，别把常驻栏永久锁在「不可见」。
    if (!storageAvailable()) { pinnedSettingsReady = true; return; }
    chrome.storage.sync.get(null, (stored) => {
      settings = cloneSettings(stored);
      invalidatePinnedCache();
      // 先立标志再挂载：mountPinnedBar 会检查它，顺序反了等于什么都没挡。
      pinnedSettingsReady = true;
      // 语言先落地：后面的状态文案与列表都按当前语言生成。
      applyInterfaceLanguage();
      setLlmDockVisible(settings.llmDockVisible);
      trigger.classList.toggle('disabled', !settings.enabled);
      loadLlmConversations();
      mountPinnedBar();
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'sync') return;
      // 只在这几个键变化时失效常驻栏缓存。搜索历史（changes.searchHistory）不在其中：
      // 它每次搜索都会变，而站点解析不读它，跟着失效会让每个标签页都白算一遍。
      if (changes.pinnedSearch || changes.sources || changes.groups || changes.specialActions ||
      changes.engines || changes.iconOnly || changes.customEngines || changes.engineOrder || changes.sourceConfigVersion) invalidatePinnedCache();
      if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
      if (changes.engines) settings.engines = { ...DEFAULT_SETTINGS.engines, ...(changes.engines.newValue || {}) };
      if (changes.iconOnly) settings.iconOnly = { ...(changes.iconOnly.newValue || {}) };
      if (changes.customEngines) settings.customEngines = Array.isArray(changes.customEngines.newValue) ? changes.customEngines.newValue : [];
      if (changes.engineOrder) settings.engineOrder = Array.isArray(changes.engineOrder.newValue) ? changes.engineOrder.newValue : DEFAULT_SETTINGS.engineOrder;
      if (changes.sources) settings.sources = Array.isArray(changes.sources.newValue) ? changes.sources.newValue : [];
      if (changes.groups) settings.groups = Array.isArray(changes.groups.newValue) ? changes.groups.newValue : [];
      if (changes.specialActions) settings.specialActions = changes.specialActions.newValue && typeof changes.specialActions.newValue === 'object' ? changes.specialActions.newValue : {};
      if (changes.language) {
        settings.language = normalizeLocale(changes.language.newValue);
        applyInterfaceLanguage();
      }
      if (changes.sourceConfigVersion) settings.sourceConfigVersion = Number(changes.sourceConfigVersion.newValue) || 0;
      if (changes.pinnedSearch) settings.pinnedSearch = changes.pinnedSearch.newValue && typeof changes.pinnedSearch.newValue === 'object' ? changes.pinnedSearch.newValue : {};
      if (changes.enabled || changes.pinnedSearch || changes.sources || changes.groups || changes.specialActions || changes.engines || changes.iconOnly || changes.customEngines || changes.engineOrder) mountPinnedBar();
      if ((changes.pinnedSearch || changes.enabled) && !pinnedBarCollapsed) {
        const currentPinnedSite = getPinnedSite();
        if (currentPinnedSite) schedulePinnedBarCollapse(currentPinnedSite);
      }
      if (changes.searchHistory) {
        settings.searchHistory = Array.isArray(changes.searchHistory.newValue) ? changes.searchHistory.newValue : [];
        if (!isEditingPinnedQuery()) syncPinnedQuery(getPinnedSite());
      }
      if (changes.llm) {
        settings.llm = normalizeLlmConfig(changes.llm.newValue);
        syncLlmConfigStatus();
      }
      if (changes.llmDockVisible) setLlmDockVisible(changes.llmDockVisible.newValue !== false);
      if (changes.triggerMode) {
        settings.triggerMode = changes.triggerMode.newValue === 'hover' ? 'hover' : 'click';
        if (getSelectionTriggerMode() !== 'hover') cancelTriggerHoverOpen();
        else if (trigger.classList.contains('visible')) scheduleTriggerHoverOpen();
      }
      if (changes.editableTriggerMode) {
        settings.editableTriggerMode = ['click', 'hover', 'none'].includes(changes.editableTriggerMode.newValue) ? changes.editableTriggerMode.newValue : DEFAULT_SETTINGS.editableTriggerMode;
        if (settings.editableTriggerMode === 'none' && selectedInput) hideAll();
        else if (getSelectionTriggerMode() !== 'hover') cancelTriggerHoverOpen();
        else if (trigger.classList.contains('visible')) scheduleTriggerHoverOpen();
      }
      if (changes.defaultGroupCount) settings.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(changes.defaultGroupCount.newValue) || DEFAULT_SETTINGS.defaultGroupCount)));
      if (changes.selectionTriggerDelay) settings.selectionTriggerDelay = Math.max(0, Math.min(2000, Math.round(Number(changes.selectionTriggerDelay.newValue) || 0)));
      trigger.classList.toggle('disabled', !settings.enabled);
      if (!settings.enabled) {
        cancelTriggerHoverOpen();
        // 扩展整个关掉了：两套 UI 的菜单都没有依附对象，一并无条件收掉。
        closeOpenModeMenu();
        setPinnedHostVisible(false);
        panelOpen = false;
        trigger.setAttribute('aria-expanded', 'false');
        panel.classList.remove('visible');
      }
      if (panelOpen) {
        renderEngines();
        positionPanel();
        positionHiddenEngineList();
      }
    });
  }

  function hideAll() {
    // 只关浮层自己那套里的菜单：常驻栏的同类菜单由它自己的收起路径负责。
    // 无条件关会误伤——右键常驻栏图标之后，一次与本菜单无关的 mouseup 也会走到这里
    // （见 closeOpenModeMenuIn 的说明）。
    closeOpenModeMenuIn(shadow);
    if (selectionShowTimer) { window.clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    if (selectionWatchTimer) { window.clearInterval(selectionWatchTimer); selectionWatchTimer = null; }
    cancelTriggerHoverOpen();
    panelOpen = false;
    expanded = false;
    expandedGroupId = null;
    trigger.classList.remove('visible');
    trigger.setAttribute('aria-expanded', 'false');
    panel.classList.remove('visible');
    queryRow.classList.remove('expanded');
    queryExpand.setAttribute('aria-expanded', 'false');
    queryExpand.title = t('展开多行输入');
    selectedText = '';
    selectedRange = null;
    selectedInput = null;
    anchorRect = null;
    contextAnchor = null;
    selectionPointer = null;
    selectionPointerPending = false;
    selectionPointerText = '';
    // 触发点与面板都收起了才收回 top layer。笔记侧栏与「问 ai」的对话层都共用同一个宿主，
    // 所以要看它们是否还开着，否则会把面板一起带下去。
    if (!llmOverlayInUse()) demoteFromTopLayer(host);
  }

  function getSelectionRect(range) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    return rects[rects.length - 1] || range.getBoundingClientRect();
  }

  function getInputSelectionRect(input, start, end) {
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const selected = input.value.slice(start, end);
    const before = input.value.slice(0, start);
    const isSingleLine = input instanceof HTMLInputElement;
    if (isSingleLine) {
      const canvas = getInputSelectionRect.canvas || (getInputSelectionRect.canvas = document.createElement('canvas'));
      const context = canvas.getContext('2d');
      if (context) {
        context.font = style.font;
        const transform = (value) => style.textTransform === 'uppercase' ? value.toUpperCase() : style.textTransform === 'lowercase' ? value.toLowerCase() : value;
        const letterSpacing = parseFloat(style.letterSpacing) || 0;
        const measure = (value) => context.measureText(transform(value)).width + letterSpacing * value.length;
        const beforeWidth = measure(before);
        const selectedWidth = Math.max(1, measure(selected));
        const left = rect.left + borderLeft + paddingLeft + beforeWidth - input.scrollLeft;
        const lineHeight = parseFloat(style.lineHeight) || rect.height;
        const top = rect.top + borderTop + Math.max(0, (rect.height - borderTop - (parseFloat(style.borderBottomWidth) || 0) - lineHeight) / 2);
        return { left, right: left + selectedWidth, top, bottom: top + lineHeight, width: selectedWidth, height: lineHeight };
      }
    }
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    mirror.style.cssText = `position:fixed;display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;visibility:hidden;pointer-events:none;white-space:${style.whiteSpace};overflow-wrap:${style.overflowWrap};word-wrap:${style.wordWrap};font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing};text-indent:${style.textIndent};text-transform:${style.textTransform};line-height:${style.lineHeight};padding:${style.padding};border:${style.border};box-sizing:${style.boxSizing};`;
    marker.style.cssText = `font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing};white-space:${style.whiteSpace};text-transform:${style.textTransform};`;
    mirror.append(document.createTextNode(before), marker, document.createTextNode(input.value.slice(end)));
    marker.textContent = selected || '\u200b';
    document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    const left = markerRect.left - input.scrollLeft;
    const top = markerRect.top - input.scrollTop;
    return { left, right: Math.max(left + 1, markerRect.right - input.scrollLeft),
    top, bottom: markerRect.bottom - input.scrollTop, width: Math.max(1, markerRect.width), height: Math.max(1, markerRect.height) };
  }

  function getInputSelection() {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return null;
    if (typeof input.selectionStart !== 'number' || typeof input.selectionEnd !== 'number' || input.selectionStart === input.selectionEnd) return null;
    // textarea 里的选区本身可能就是多行，保留它的换行；单行 input 显示不了换行，仍压平。
    const text = normalizeSelectionText(input.value.slice(input.selectionStart, input.selectionEnd), input instanceof HTMLTextAreaElement);
    if (!text) return null;
    return { text, input, rect: getInputSelectionRect(input, input.selectionStart, input.selectionEnd) };
  }

  function getContentEditableSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const editable = anchor?.closest?.('[contenteditable="true"]');
    if (!editable || !editable.isContentEditable || !editable.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    // 页面正文的选区天然带段落边界，保留换行与段间空行，别把多段挤成一行。
    const text = normalizeSelectionText(selection.toString(), true);
    if (!text) return null;
    return { text, element: editable, range, rect: getSelectionRect(range) };
  }

  /**
   * 选中文字落在**页面自己的 shadow DOM** 里时，取回选区。
   *
   * 为什么必须单独处理：浏览器对「选区跨过影子边界」的情况，会让 window.getSelection()
   * 返回一个 `isCollapsed === true` 的选区（`toString()` 却仍有文字，`getRangeAt(0)`
   * 是一段空 range、几何全为 0）。于是 showForSelection 里「collapsed 就当没有选区」
   * 的判定会把这类选区整个丢掉——表现就是「有些地方选中文字不出图标」。
   * 这与本扩展自己的 shadow root 无关（宿主是文档里普通元素，选区仍在 document 树内）。
   *
   * Chromium 在 shadowRoot 上提供了非标准的 `getSelection()`，在**拥有选区的那个根**上
   * 调用会得到正常折叠状态与真实几何；在别的根上调用则返回折叠选区。据此判定归属。
   * 只遍历 open 的 shadow root —— closed 的取不到内部选区，只能保持现状。
   *
   * 遍历有代价（每层都要 getSelection()），所以挂在 mouseup / selectionchange 上，
   * 且只在「document 选区为空或已折叠」时才走这条路径：主文档选区不受影响、不付这个成本。
   */
  function getShadowSelection(): ShadowSelectionHit | null {
    let found: ShadowSelectionHit | null = null;
    // 参数显式标 any：本文件尚未补齐类型，未标注的参数每处都记一个隐式 any（见 README 记账口径）。
    const visit = (root: any) => {
      if (found) return;
      let elements: any;
      try { elements = root.querySelectorAll('*'); } catch { return; }
      for (const element of elements) {
        if (found) return;
        const shadowRoot = element.shadowRoot;
        if (!shadowRoot) continue;
        try {
          const selection = typeof shadowRoot.getSelection === 'function' ? shadowRoot.getSelection() : null;
          if (selection && selection.rangeCount && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            // 页面正文的选区天然带段落边界，保留换行与段间空行。
            const text = normalizeSelectionText(selection.toString(), true);
            if (text) { found = { text, range, rect: getSelectionRect(range) }; return; }
          }
        } catch { /* 取不到就跳过这个根 */ }
        visit(shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  /**
   * 这段几何形状的选区，用户此刻在屏幕上看得见吗？
   *
   * 「有选区」与「用户看得见选区」是两件事，而触发点该由后者决定：选区可以被脚本造在
   * 任何地方——离屏的 textarea / div（页面「复制到剪贴板」的常见手法就是 select() 一个
   * 藏在 -9999px 的元素，一个字都不在屏幕上）、滚出视口的段落、opacity:0 的隐藏文字。
   * 这些选区一旦照样弹图标，用户看到的就是「明明没选中任何文字，图标却冒出来」，
   * 而且 positionTrigger 还会把它夹到视口边上，位置和任何文字都对不上。
   *
   * 下限 2×6px 挡的是 sr-only 那一类：clip:rect(0,0,0,0) + 1×1 的文本框，几何上「在视口里」，
   * 但只有 1 个像素，屏幕上同样什么都看不见。
   */
  function rectIsVisibleOnScreen(rect: any) {
    if (!rect) return false;
    if (!(rect.width >= 2 && rect.height >= 6)) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  }

  /** 选区里是否至少有一行落在视口内。跨多行的选区（整页 Ctrl+A）只要有一行可见就算看得见。 */
  function rangeHasVisibleRect(range: any) {
    if (!range) return false;
    let rects: any;
    try { rects = range.getClientRects(); } catch { return false; }
    for (const rect of rects) if (rectIsVisibleOnScreen(rect)) return true;
    return false;
  }

  /** 选区所在的元素：文本节点向上取父元素。 */
  function rangeOwnerElement(range: any) {
    const node: any = range?.startContainer;
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  /**
   * 选区所在的元素是否真的被渲染出来。
   *
   * 只看几何不够：opacity:0 / visibility:hidden 的元素仍然有布局盒，矩形完全正常，
   * 屏幕上却没有字。checkVisibility 覆盖这两种；拿不到这个 API 时按「可见」放行，
   * 不让能力缺失反过来把正常选区挡掉。
   */
  function elementIsVisibleOnScreen(element: any) {
    if (!element || typeof element.checkVisibility !== 'function') return true;
    try { return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { return true; }
  }

  /** 当前选区内屏幕上真的看得见吗（几何 + 元素可见性）。 */
  function liveSelectionIsOnScreen(live: any) {
    if (!live || !elementIsVisibleOnScreen(live.element)) return false;
    // 输入框的选区只有一段几何，直接判它。
    if (live.inputSelection) return rectIsVisibleOnScreen(live.rect);
    // 文档 / contenteditable / 影子根的选区可能跨很多行：只要有一行在视口里就算看得见。
    return rangeHasVisibleRect(live.range) || rectIsVisibleOnScreen(live.rect);
  }

  function positionTrigger(rect) {
    const triggerSize = 25;
    const left = Math.max(8, Math.min(window.innerWidth - triggerSize - 8, rect.right + 9));
    const top = Math.max(8, Math.min(window.innerHeight - triggerSize - 8, rect.top + (rect.height - triggerSize) / 2));
    trigger.style.left = `${left}px`;
    trigger.style.top = `${top}px`;
    return { left, top };
  }

  function positionPanel(rect, triggerPosition) {
    if (panelManuallyMoved) return;
    const panelWidth = Math.min(panel.offsetWidth || 362, window.innerWidth - 20);
    const panelHeight = panel.offsetHeight || 95;
    const triggerRect = trigger.getBoundingClientRect();
    const anchor = contextAnchor || triggerRect;
    const centeredLeft = selectionPointer ? selectionPointer.x - panelWidth / 2 : triggerRect.left;
    const left = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, contextAnchor ? anchor.left : centeredLeft));
    const gap = 7;
    let top = selectionPointer && !contextAnchor ? selectionPointer.y + gap : anchor.bottom + gap;
    const upperAnchor = selectionPointer && !contextAnchor ? selectionPointer.y : anchor.top;
    if (top + panelHeight > window.innerHeight - 10 && upperAnchor - panelHeight - gap >= 10) top = upperAnchor - panelHeight - gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function resizeQueryInput() {
    queryInput.style.height = 'auto';
    const minHeight = 28;
    const maxHeight = 116;
    const height = Math.max(minHeight, Math.min(maxHeight, queryInput.scrollHeight || minHeight));
    queryInput.style.height = `${height}px`;
    queryInput.style.overflowY = (queryInput.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
  }

  /** 切到多行输入外观。展开态只改内边距与行高，能装下的高度由 resizeQueryInput 现算。 */
  function setQueryRowExpanded(expanded: any) {
    queryRow.classList.toggle('expanded', expanded);
    queryExpand.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? t('收起多行输入') : t('展开多行输入');
    queryExpand.setAttribute('aria-label', label);
    queryExpand.setAttribute('title', label);
  }

  /** 多行选区进框时自动展开：单行外观会把换行挤在一行的行高里，看不出来是几段。 */
  function syncQueryRowExpandForText(text: any) {
    if (String(text || '').includes('\n')) setQueryRowExpanded(true);
  }

  /**
   * 当前配置下的条目解析统一走 shared/settings-store.ts。
   *
   * 这里此前有三份几乎同构的实现：浮层用的 getAvailableEngines、常驻栏用的
   * getPinnedEntries、分组飞层用的 getPinnedGroupSources。它们对「哪些条目该出现」
   * 的判断本该一致，实际连分组角标（浮层 '群'、常驻栏 '组'）和空名兜底都不一样。
   * 现在三处共用同一个纯函数，本文件只保留 DOM 适配与缓存。
   */
  function normalizedConfig() {
    if (!normalizedConfigCache) normalizedConfigCache = normalizeSearchConfig(settings);
    return normalizedConfigCache;
  }

  function getAvailableEngines() {
    return resolveGroupEntries(normalizedConfig(), 'default');
  }

  function getGroupSources(groupId) {
    return resolveGroupEntries(normalizedConfig(), groupId);
  }

  function rememberSearch(query) {
    // 从编码 URL 抄来的查询先还原再入库，否则这串 %XX 会作为「最近一次搜索」
    // 被常驻栏在之后每个没有查询的页面上兜底显示出来。
    const normalized = decodeQueryText(query).replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const history = settings.searchHistory
      .map((item) => typeof item === 'string' ? { query: item } : item)
      .filter((item) => item && item.query && item.query !== normalized);
    history.unshift({ query: normalized, timestamp: Date.now() });
    settings.searchHistory = history.slice(0, 20);
    if (storageAvailable()) chrome.storage.sync.set({ searchHistory: settings.searchHistory });
  }

  async function copyTextToClipboard(text) {
    const value = String(text || '');
    if (!value) return false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return true; } catch { /* use the legacy fallback */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value; textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.append(textarea);
    try { textarea.select(); return document.execCommand('copy'); }
    catch { return false; }
    finally { textarea.remove(); }
  }

  function getSearchUrl(engine, query) {
    if (engine.id === 'doubao') return `https://www.doubao.com/chat/?quickfind=${encodeURIComponent(query)}`;
    return typeof engine.buildUrl === 'function'
      ? engine.buildUrl(query)
      : engine.url.replace(/\{query\}/gi, encodeURIComponent(query));
  }

  function isPinnedSearchResults(siteId) {
    const params = new URLSearchParams(location.search);
    if (siteId === 'google-scholar') return /^\/scholar\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'google') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'baidu') return /^\/s\/?$/i.test(location.pathname) && (params.has('wd') || params.has('word') || params.has('q'));
    if (siteId === 'duckduckgo') return (/^\/(?:html\/?)?$/i.test(location.pathname) || /^\/lite\/?$/i.test(location.pathname)) && params.has('q');
    if (siteId === 'so') return /^\/s\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'sogou') return /^\/web\/?$/i.test(location.pathname) && (params.has('query') || params.has('q'));
    if (siteId === 'bing') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'yandex') return /^\/search\/?$/i.test(location.pathname) && params.has('text');
    if (siteId === 'zhihu') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'bilibili') return /^\/all\/?$/i.test(location.pathname) && params.has('keyword');
    if (siteId === 'douyin') return /^\/search(?:\/|$)/i.test(location.pathname) && (location.pathname.length > 8 || params.has('q') || params.has('keyword'));
    return false;
  }

  function createTemplateSite(source) {
    if (!source?.id) return null;
    const sourceName = String(source.name || source.id);
    const template = String(source.url || '');
    if (!template && typeof source.buildUrl !== 'function') return null;
    try {
      const marker = '__quickfind_query__';
      const candidateUrl = template && /\{query\}/i.test(template)
        ? template.replace(/\{query\}/gi, marker)
        : getSearchUrl(source, marker);
      const parsed = new URL(candidateUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported protocol');
      const path = decodeURIComponent(parsed.pathname || '/');
      const pathMarker = path.toLowerCase().indexOf(marker.toLowerCase());
      const queryKeys = [];
      parsed.searchParams.forEach((value, key) => { if (value.toLowerCase().includes(marker.toLowerCase())) queryKeys.push(key); });
      return {
        id: String(source.id), name: sourceName, host: parsed.hostname.toLowerCase(), path,
        pathPrefix: pathMarker >= 0 ? path.slice(0, pathMarker) : '', pathSuffix: pathMarker >= 0 ? path.slice(pathMarker + marker.length) : '',
        pathHasMarker: pathMarker >= 0, queryKeys, selector: String(source.pinnedInputSelector || source.selector || GENERIC_PINNED_INPUT_SELECTOR),
        selectorConfigured: Boolean(String(source.pinnedInputSelector || source.selector || '').trim()),
        categorySelectors: Array.isArray(source.pinnedCategorySelectors) ? source.pinnedCategorySelectors.map(String) : [], dynamic: true,
        loose: !/\{query\}/i.test(template)
      };
    } catch {
      const raw = String(source.url || '').trim();
      const hostSource = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
      const host = (hostSource.match(/(?:www\.)?([^/\s:?]+)(?::\d+)?/) || [])[1];
      return host ? { id: String(source.id), name: sourceName,
      host: host.toLowerCase(), path: '/', pathPrefix: '', pathSuffix: '',
      pathHasMarker: false, queryKeys: [], selector: String(source.pinnedInputSelector || source.selector || GENERIC_PINNED_INPUT_SELECTOR),
      selectorConfigured: Boolean(String(source.pinnedInputSelector || source.selector || '').trim()), categorySelectors: [], dynamic: true, loose: true } : null;
    }
  }

  function getDynamicPinnedSites() {
    const map = new Map();
    const pinned = settings?.pinnedSearch;
    const customSites = Array.isArray(pinned?.customSites) ? pinned.customSites : [];
    const addSources = (sources) => (Array.isArray(sources) ? sources : []).forEach((source) => {
      const site = createTemplateSite(source);
      if (site && !map.has(site.id)) map.set(site.id, site);
    });
    customSites.forEach((site) => {
      const descriptor = createTemplateSite(site);
      if (descriptor && !map.has(descriptor.id)) map.set(descriptor.id, descriptor);
    });
    addSources(settings?.sources);
    addSources(settings?.customEngines);
    if (!map.size) addSources(ENGINES.map((engine) => ({ ...engine, url: getSearchUrl(engine, 'quickfind') })));
    return Array.from(map.values());
  }

  function matchesDynamicPinnedSite(site) {
    const hostname = location.hostname.toLowerCase();
    const host = String(site.host || '').replace(/^www\./, '');
    const currentHost = hostname.replace(/^www\./, '');
    if (!(currentHost === host || currentHost.endsWith('.' + host))) return false;
    if (site.loose) return true;
    let pathname = location.pathname || '/';
    try { pathname = decodeURIComponent(pathname); } catch { /* keep encoded path */ }
    if (site.pathHasMarker) {
      if (!pathname.toLowerCase().startsWith(site.pathPrefix.toLowerCase()) || !pathname.toLowerCase().endsWith(site.pathSuffix.toLowerCase())) return false;
      const value = pathname.slice(site.pathPrefix.length, pathname.length - site.pathSuffix.length || undefined);
      if (!value || value.toLowerCase() === '__quickfind_query__') return false;
    } else {
      const normalizePath = (value) => String(value || '/').replace(/\/+$/, '') || '/';
      if (normalizePath(pathname) !== normalizePath(site.path)) return false;
      if (!site.queryKeys.length) return false;
      const params = new URLSearchParams(location.search);
      if (!site.queryKeys.some((key) => params.has(key))) return false;
    }
    return true;
  }

  // 常驻栏的站点解析只取决于 settings 与 location，却挂在 MutationObserver、滚动、页面输入、
  // 选区变化这些高频路径上——每次 DOM 变动、每次滚动、页面上任何输入框的每次按键都要问一次。
  // 这里按 (location.href, 是否需要命中搜索结果页) 记忆化。缓存里放的是按 id/host 定位的纯数据，
  // 不持有 DOM 引用；settings 一变就整体失效，见 invalidatePinnedCache。
  let pinnedSiteCacheKey = '';
  // 用独立哨兵表示「这个 URL 还没算过」。resolvePinnedSite 返回 null 是合法答案（当前站点
  // 不需要常驻栏），拿 null 当未命中会让最常见的那种页面每次都重算一遍。
  const PINNED_SITE_UNCACHED: any = Symbol('quickfind-uncached');
  let pinnedSiteStrictCache: any = PINNED_SITE_UNCACHED;
  let pinnedSiteLooseCache: any = PINNED_SITE_UNCACHED;
  let pinnedEntriesCache: any = null;
  /** 收敛后的 sources + groups，见 normalizedConfig()。任何一次设置变动都要作废。 */
  let normalizedConfigCache: any = null;

  function invalidatePinnedCache() {
    pinnedSiteCacheKey = '';
    pinnedSiteStrictCache = PINNED_SITE_UNCACHED;
    pinnedSiteLooseCache = PINNED_SITE_UNCACHED;
    pinnedEntriesCache = null;
    normalizedConfigCache = null;
    // 渲染指纹也要一起作废：设置一变，条目/图标/顺序都可能变，但指纹是独立于 settings 的
    // 一个字符串，不主动清空就会命中「结构未变」的早退，界面停在旧配置上。
    pinnedRenderSignature = '';
  }

  function getPinnedSite(options = {}) {
    const key = location.href;
    // 两份结果分开存：requireSearchResults 为 false 时不要求「当前页是搜索结果页」。
    if (pinnedSiteCacheKey !== key) {
      pinnedSiteCacheKey = key;
      pinnedSiteStrictCache = PINNED_SITE_UNCACHED;
      pinnedSiteLooseCache = PINNED_SITE_UNCACHED;
    }
    if (options.requireSearchResults === false) {
      if (pinnedSiteLooseCache === PINNED_SITE_UNCACHED) pinnedSiteLooseCache = resolvePinnedSite(options);
      return pinnedSiteLooseCache;
    }
    if (pinnedSiteStrictCache === PINNED_SITE_UNCACHED) pinnedSiteStrictCache = resolvePinnedSite(options);
    return pinnedSiteStrictCache;
  }

  function resolvePinnedSite(options = {}) {
    const requireSearchResults = options.requireSearchResults !== false;
    const hostname = location.hostname.toLowerCase();
    const pinned = settings?.pinnedSearch;
    const hasPinnedSiteConfig = Number(pinned?.siteConfigVersion) >= PINNED_SITE_CONFIG_VERSION;
    const enabledSites = hasPinnedSiteConfig && Array.isArray(pinned?.sites)
      ? new Set(pinned.sites.map(String))
      : Array.isArray(pinned?.sites)
        ? new Set([...pinned.sites.map(String), ...DEFAULT_PINNED_SITE_IDS.filter((id) => !LEGACY_PINNED_SITE_IDS.has(id))])
        : new Set(DEFAULT_PINNED_SITE_IDS);
    let site = null;
    if (/(^|\.)scholar\.google\.com$/.test(hostname) && enabledSites.has('google-scholar')) site = { id: 'google-scholar', selector: 'input[name="q"], input.gs_in_txt, textarea[name="q"]', selectorConfigured: true, categorySelectors: ['#gs_ab', '#gs_hdr'] };
    else if (/(^|\.)google\./.test(hostname) && enabledSites.has('google')) site = { id: 'google', selector: 'textarea[name="q"], input[name="q"]', selectorConfigured: true, categorySelectors: ['#hdtb', '#top_nav', '[role="navigation"] #hdtb-msb'] };
    else if (/(^|\.)baidu\.com$/.test(hostname) && enabledSites.has('baidu')) site = { id: 'baidu', selector: 'input#kw, input[name="wd"], input[name="word"], textarea#kw', selectorConfigured: true, categorySelectors: ['#s_tab', '#form', '[class*="s_tab"]'] };
    else if (/(^|\.)duckduckgo\.com$/.test(hostname) && enabledSites.has('duckduckgo')) site = { id: 'duckduckgo', selector: 'input[name="q"], #search_form_input, #search_form_input_homepage, input[aria-label*="Search"]', selectorConfigured: true, categorySelectors: ['#duckbar', '#duckbar_static', '[data-testid="search-filters"]'] };
    else if (/(^|\.)so\.com$/.test(hostname) && enabledSites.has('so')) site = { id: 'so', selector: 'input#input, input#search-input, input[name="q"], input[placeholder*="搜索"]', selectorConfigured: true, categorySelectors: ['.search-menu', '.search-nav', '[class*="search-nav"]'] };
    else if (/(^|\.)sogou\.com$/.test(hostname) && enabledSites.has('sogou')) site = { id: 'sogou', selector: 'input#query, input[name="query"], input[name="q"], input[placeholder*="搜索"]', selectorConfigured: true, categorySelectors: ['.search-nav', '#searchTab', '[class*="search-tab"]'] };
    else if (/(^|\.)bing\.com$/.test(hostname) && enabledSites.has('bing')) site = { id: 'bing', selector: 'input[name="q"]', selectorConfigured: true, categorySelectors: ['#b-scopebar', '[role="navigation"] #b-scopebar'] };
    else if (/(^|\.)yandex\.(com|ru)$/.test(hostname) && enabledSites.has('yandex')) site = { id: 'yandex', selector: 'input[name="text"], textarea[name="text"], input#text', selectorConfigured: true, categorySelectors: ['.navigation__items', '.serp-header .navigation', '[class*="Navigation"]'] };
    else if (/(^|\.)zhihu\.com$/.test(hostname) && enabledSites.has('zhihu')) site = { id: 'zhihu', selector: 'input[name="q"], input[placeholder*="搜索"], input[aria-label*="搜索"]', selectorConfigured: true, categorySelectors: ['.SearchTabs', '[class*="SearchTabs"]'] };
    else if (/(^|\.)bilibili\.com$/.test(hostname) && enabledSites.has('bilibili')) site = { id: 'bilibili', selector: 'input.nav-search-input, input.search-input, input[name="keyword"], input[placeholder*="搜索"], input[placeholder*="搜"]', selectorConfigured: true, categorySelectors: ['.search-tabs', '.search-header-tabs', '[class*="search-tabs"]'] };
    else if (/(^|\.)douyin\.com$/.test(hostname) && enabledSites.has('douyin')) site = { id: 'douyin', selector: 'input[data-e2e="searchbar-input"], input[placeholder*="搜索"], input[aria-label*="搜索"], input[name="keyword"]', selectorConfigured: true, categorySelectors: ['[data-e2e="search-tabs"]', '[class*="search-tab"]', '[class*="searchTab"]'] };
    const override = Array.isArray(pinned?.customSites) ? pinned.customSites.find((item) => String(item?.id) === String(site?.id)) : null;
    if (site && override) {
      const builtin = ENGINES.find((engine) => engine.id === site.id) || {};
      const overridden = createTemplateSite({ ...builtin, ...site, ...override, id: site.id, name: override.name || site.id, url: override.url || builtin.url });
      const host = String(overridden?.host || '').replace(/^www\./, '');
      const currentHost = hostname.replace(/^www\./, '');
      site = overridden && (currentHost === host || currentHost.endsWith('.' + host)) ? { ...site, ...overridden } : null;
    }
    if (site && requireSearchResults && pinned?.allSites !== true && !isPinnedSearchResults(site.id)) site = null;
    if (!site) {
      site = getDynamicPinnedSites().find((candidate) => enabledSites.has(candidate.id)
        && (requireSearchResults ? matchesDynamicPinnedSite(candidate) : (() => {
          const host = String(candidate.host || '').replace(/^www\./, '');
          const currentHost = hostname.replace(/^www\./, '');
          return currentHost === host || currentHost.endsWith('.' + host);
        })())) || null;
    }
    if (!site && pinned?.allSites === true) {
      const currentHost = hostname.replace(/^www\./, '');
      site = getDynamicPinnedSites().find((candidate) => enabledSites.has(candidate.id) &&
      (currentHost === String(candidate.host || '').replace(/^www\./, '') || currentHost.endsWith('.' + String(candidate.host || '').replace(/^www\./, '')))) || {
        id: 'all-sites', name: t('当前站点'), host: hostname, path: '/',
        pathPrefix: '', pathSuffix: '', pathHasMarker: false, queryKeys: [], selector: GENERIC_PINNED_INPUT_SELECTOR, selectorConfigured: false, categorySelectors: [], dynamic: true, loose: true
      };
    }
    if (!site || (requireSearchResults && pinned?.allSites !== true && site.dynamic && !matchesDynamicPinnedSite(site))) return null;
    return site;
  }

  function findVisibleInput(selector) {
    try {
      return Array.from(document.querySelectorAll(selector)).find((input) => {
        const rect = input.getBoundingClientRect();
        return rect.width > 20 && rect.height > 10 && getComputedStyle(input).visibility !== 'hidden';
      }) || null;
    } catch { return null; }
  }

  function findVisibleElement(selectors) {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 20 && rect.height > 10 && getComputedStyle(candidate).visibility !== 'hidden';
      });
      if (element) return element;
    }
    return null;
  }

  function getPinnedConfig() {
    const pinned = settings.pinnedSearch || {};
    return {
      sources: settings.sources,
      groups: settings.groups,
      engines: settings.engines,
      iconOnly: settings.iconOnly,
      engineOrder: settings.engineOrder,
      customEngines: settings.customEngines,
      customSites: pinned.customSites,
      defaultGroupCount: pinned.defaultGroupCount,
      collapseDelay: pinned.collapseDelay,
      openInNewTab: pinned.openInNewTab === true,
      allSites: pinned.allSites === true,
      siteConfigVersion: settings.sourceConfigVersion >= 5 ? PINNED_SITE_CONFIG_VERSION : 0
    };
  }

  function getPinnedDefaultGroupCount() {
    return Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(getPinnedConfig().defaultGroupCount ?? DEFAULT_PINNED_SEARCH.defaultGroupCount) || DEFAULT_PINNED_SEARCH.defaultGroupCount)));
  }

  function getPinnedOpenInNewTab() {
    return getPinnedConfig().openInNewTab === true;
  }

  function setPinnedOpenInNewTab(openInNewTab) {
    settings.pinnedSearch = { ...(settings.pinnedSearch || {}), openInNewTab: Boolean(openInNewTab) };
    // 这里改了 settings 但没走 storage 回调，缓存要就地失效（尽管 openInNewTab 不影响站点解析，
    // 用了缓存的读取方不应依赖「哪个字段会变」这种耦合）。
    invalidatePinnedCache();
    syncPinnedOpenModeButton();
    if (storageAvailable()) chrome.storage.sync.set({ pinnedSearch: settings.pinnedSearch });
  }

  function openPinnedSearchInNewTab(url) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'open-search-tab', url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /**
   * 关掉「打开方式」菜单。
   *
   * 菜单是挂在浮层同一 shadow root 里的临时节点：菜单开着时浮层重绘、页面滚动、
   * 用户按 Esc 或点了别处，都要把它收掉，否则它会留在原地且失去被选中的对象。
   */
  function closeOpenModeMenu() {
    if (!openModeMenu) return;
    const { element, cleanup } = openModeMenu;
    openModeMenu = null;
    cleanup();
    element.remove();
  }

  /**
   * 只关掉开在 root 这一套 UI 里的菜单。
   *
   * 为什么必须区分归属：同一个菜单有两个入口——选中文字浮层（host 的 shadow root）与
   * 常驻搜索栏（pinned host 的 shadow root）。两套 UI 各有自己的收尾（hideAll、
   * 常驻栏收起），那些收尾只该带走自己那一套里的菜单。此前它们都无条件调
   * closeOpenModeMenu()，于是出现「右击常驻栏图标，菜单出现一下马上消失」：
   *
   *   右键按下/抬起（button=2）同样走 document 上的 mousedown/mouseup 监听，
   *   而常驻栏不在 eventInsideOverlay(event) 的范围内 —— 于是 mouseup 照样排定
   *   scheduleSelectionDisplay()，selectionTriggerDelay 之后 showForSelection()
   *   发现没有选区就调 hideAll()，hideAll 顺手把刚弹出的常驻栏菜单拆了。
   *   实测消失时刻与 selectionTriggerDelay 严格同步（默认 200ms）。
   *
   * root 为空时退化成「无条件关闭」，供「整个扩展 UI 停用」这类收尾使用。
   */
  function closeOpenModeMenuIn(root: any) {
    if (!openModeMenu) return;
    if (root && openModeMenu.root !== root) return;
    closeOpenModeMenu();
  }

  /**
   * 右键搜索源图标时弹出的「本标签打开 / 新建标签打开」菜单。
   *
   * 为什么做成按次选择而不是又一个全局开关：常驻栏已有「新标签/本页」的默认开关，
   * 但用户经常只是一次性想换个地方打开（比如在结果页里连着换词搜索，不想开一堆标签）。
   * 菜单只负责显示与回调，具体怎么开由调用方传进来的 run 决定。
   *
   * root 传事件源的 shadow root：菜单必须和触发它的按钮同处一个 shadow tree，
   * 否则样式（宿主 all:initial）与层级都对不上。
   */
  function showOpenModeMenu(root, point, choices) {
    if (!root) return;
    closeOpenModeMenu();
    const menu = document.createElement('div');
    menu.className = 'qf-open-menu';
    menu.setAttribute('role', 'menu');
    choices.forEach((choice) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'qf-open-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = choice.label;
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeOpenModeMenu();
        choice.run();
      });
      menu.append(item);
    });
    root.append(menu);
    // 先量尺寸再夹进视口：贴着窗口右下角右键时，菜单要向回缩而不是被裁掉。
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, point.x));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, point.y));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    const onPointerDown = (event) => {
      if (typeof event.composedPath === 'function' && event.composedPath().includes(menu)) return;
      closeOpenModeMenu();
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeOpenModeMenu();
    };
    const onViewportChange = () => closeOpenModeMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    openModeMenu = {
      element: menu,
      // 归属哪套 shadow tree：收尾时据此判断「该不该由我来关」（见 closeOpenModeMenuIn）。
      root,
      cleanup: () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
      }
    };
    menu.querySelector('.qf-open-menu-item')?.focus({ preventScroll: true });
  }

  function getPinnedEntries() {
    if (pinnedEntriesCache) return pinnedEntriesCache;
    pinnedEntriesCache = resolveGroupEntries(normalizedConfig(), 'default');
    return pinnedEntriesCache;
  }

  function getPinnedGroupSources(groupId) {
    return resolveGroupEntries(normalizedConfig(), groupId);
  }

  /**
   * 打开浮层时把它提升到 top layer。
   *
   * 为什么需要：页面上存在 `z-index:2147483647 !important` 的透明全屏层（埋点/蒙层）时，
   * 它和扩展的浮层同为最大层级，靠 z-index 硬顶没有可靠的先后关系，实测宿主会被它压在下面、
   * 用户点不动。top layer 不参与 z-index 竞争，是这种情况下唯一稳的方案。
   *
   * 做成「尽量提升、失败不影响显示」：浏览器不支持 popover 时照旧走 z-index，
   * 所以调用点不需要各自判断。
   */
  function promoteToTopLayer(el) {
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      // 已是 popover 状态时重复调用会抛错，先查一下。
      if (el.matches?.(':popover-open')) return;
      el.showPopover();
      el.classList.add('is-top-layer');
    } catch { /* 浏览器拒绝提升时保留 z-index 路径，显示不受影响 */ }
  }

  /** 收回 top layer。隐藏浮层时必须成对调用，否则 popover 会一直挡着页面。 */
  function demoteFromTopLayer(el) {
    if (!el || typeof el.hidePopover !== 'function') return;
    try {
      if (el.matches?.(':popover-open')) el.hidePopover();
      el.classList.remove('is-top-layer');
    } catch { /* 已经关掉了 */ }
  }

  function ensurePinnedHost() {
    if (pinnedHost?.shadowRoot) return pinnedHost;
    pinnedHost = document.createElement('div');
    pinnedHost.id = 'quickfind-pinned-search-host';
    // 不用 inline 的 display：inline 样式会压过 [hidden] 的 UA 规则，令 hidden 形同虚设。
    // 常规显示由下面 :host 的 display:block 提供，隐藏走 :host([hidden])。
    pinnedHost.style.cssText = 'position:fixed;z-index:2147483646;max-width:calc(100vw - 20px);pointer-events:none;';
    // popover 属性让宿主有资格进 top layer（见 promoteToTopLayer）。UA 默认样式会把它拉成
    // 整屏带边框，所以只声明属性、把样式留给下面的 CSS 覆盖。
    pinnedHost.setAttribute('popover', 'manual');
    // 建出来就是「收起 + 不可见」，而不是等第一次 mount 之后再补。
    //
    // 这两句都必须在宿主入文档之前定好，否则第一帧就可能按「展开」算样式：`.bar` 的高度
    // 带 0.22s 过渡，只要有一帧按展开算过，收起就会变成「先撑开再缩回」的动画——
    // 用户看到的就是那条一闪而过的展开栏。类名在插入前加上，首帧即收起，没有过渡起点。
    // 不可见同理会由第一次 mount 显式打开（renderPinnedBar / positionPinnedBar 都会调
    // setPinnedHostVisible），所以这里先关着不会漏显示。
    pinnedHost.classList.add('is-collapsed');
    pinnedHost.hidden = true;
    const root = pinnedHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial;display:block;width:max-content;max-width:calc(100vw - 20px);overflow:visible}
        :host([hidden]){display:none}
        /* 收起态**不再收窄宿主**。曾用 :host(.is-collapsed){width:52px} 把宿主塌成把手大小，
           但宽度在同一帧内 377.6px → 52px 的硬跳变会把锚点一起拽走（实测 left 362 → 524），
           而 .bar 的高度还在走 0.22s 过渡 —— 用户看到的是「整条栏先闪一下跳到右边、再慢慢
           收上去」，即报告的「收起的动画一闪一闪地偏移方向」。
           宿主宽度恒定后 .bar 原地做高度过渡，横向零位移。
           热区也不再依赖宿主矩形：改为按把手的水平中心取 52×24 判定框（见 pointermove
           监听），面积与收窄方案逐像素一致，不会退回「响应范围过大」。 */
        /* 收起态那根胶囊要贴着屏幕边缘，不能浮在把手中段——否则「贴边」只是宿主的属性，
           用户眼里它离边缘还有十几像素。 */
        :host(.is-collapsed) .reveal-handle{place-items:start center;padding-top:3px}
        /* popover 的 UA 默认样式（inset:0 / margin:auto / border / padding / overflow:auto）
           必须逐项压掉，否则宿主被拉成整屏还带默认边框。只声明属性是为了拿 top layer。 */
        :host([popover]){position:fixed;inset:auto;margin:0;padding:0;border:0;overflow:visible;background:transparent;max-width:none;max-height:none}
        .bar{--pinned-bar-border-size:1px;box-sizing:border-box;display:block;width:max-content;max-width:calc(100vw - 20px);height:var(--pinned-bar-height,auto);border:var(--pinned-bar-border-size) solid rgba(17,24,39,.08);border-radius:0 0 7px 7px;background:rgba(255,255,255,.96);box-shadow:0 10px 24px rgba(17,24,39,.14),0 2px 4px rgba(17,24,39,.05);backdrop-filter:blur(14px) saturate(1.1);-webkit-backdrop-filter:blur(14px) saturate(1.1);overflow:hidden;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:auto;transform:translateY(0);transition:height .22s cubic-bezier(.2,.8,.2,1),transform .22s cubic-bezier(.2,.8,.2,1),border-width .22s cubic-bezier(.2,.8,.2,1),box-shadow .18s ease;will-change:height,transform}
        .bar-content{display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:3px 5px 4px}
        :host(.is-collapsed) .bar{height:0;border-width:0;box-shadow:none;transform:translateY(-7px);pointer-events:none}
        .pinned-query-row{display:flex;flex:0 0 auto;gap:3px;width:100%;min-width:180px;max-width:calc(100vw - 34px)}
        .pinned-query{flex:1 1 auto;width:0;height:24px;min-width:0;padding:2px 7px;border:1px solid #d7d9df;border-radius:5px;outline:none;color:#17181c;background:#fff;font:11px/17px Inter,ui-sans-serif,sans-serif}
        .pinned-query:focus{border-color:#2f795b;box-shadow:0 0 0 2px rgba(47,121,91,.12)}
        .pinned-open-mode{display:grid;place-items:center;flex:0 0 auto;width:24px;height:24px;padding:0;border:1px solid #d7d9df;border-radius:5px;color:#8a9099;background:#fff;cursor:pointer}
        .pinned-open-mode:hover{border-color:#c9ccd2;color:#17181c;background:#f6f7f8}.pinned-open-mode[aria-pressed="true"]{border-color:#2f795b;color:#2f795b;background:#f4f6f5}.pinned-open-mode:focus-visible{outline:2px solid #2f795b;outline-offset:2px}
        .pinned-open-mode svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
        /* 收起态的展开热区。视觉上仍是一条细把手，但命中范围必须够大：
           此前热区只有 78x9，鼠标不经它直接移到下方图标位置时栏不会展开，
           点击直接穿透给页面——这正是「点搜索图标没反应」的来源。
           加宽到整个宿主宽度、加高到 24px，并去掉自身描边与底色，
           可见部分交给 ::before 那条 30x2 的胶囊。 */
        /* 收起态的展开热区。视觉上仍是一条细把手，但命中范围必须够大：
           此前热区只有 78x9，鼠标不经它直接移到下方图标位置时栏不会展开，
           点击直接穿透给页面——这正是「点搜索图标没反应」的来源。
           加宽到整个宿主宽度、加高到 24px，并去掉自身描边与底色，
           可见部分交给 ::before 那条 30x2 的胶囊。 */
        .reveal-handle{display:grid;place-items:center;width:52px;margin:0 auto;height:24px;padding:0;border:0;color:#c3c7cf;background:transparent;cursor:pointer;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(-7px);transition:transform .16s cubic-bezier(.2,.8,.2,1),opacity .12s ease,visibility 0s linear .16s}
        :host(.is-collapsed) .reveal-handle{pointer-events:auto;opacity:1;visibility:visible;transform:translateY(0);transition-delay:.04s,.04s,0s}
        .reveal-handle::before{content:"";width:30px;height:2px;border-radius:99px;background:currentColor}
        .reveal-handle:hover{color:#17181c}
        .reveal-handle:focus-visible{outline:2px solid #2f795b;outline-offset:2px}
        .entries{display:flex;align-items:center;flex:0 0 auto;flex-wrap:nowrap;gap:4px;width:100%;min-width:0;max-width:calc(100vw - 34px);overflow-x:auto}
        .entry{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:23px;padding:2px 6px 2px 3px;border:1px solid #d7d9df;border-radius:5px;color:#33363d;background:#fff;font:600 11px/1.2 Inter,ui-sans-serif,sans-serif;cursor:pointer}
        .entry.icon-only{gap:0;padding-right:4px}.entry.icon-only .name{display:none}
        .entry:hover{border-color:#c9ccd2;background:#f6f7f8}.entry:focus-visible{outline:2px solid #2f795b;outline-offset:2px}
        .mark{display:grid;place-items:center;width:17px;height:17px;overflow:hidden;border-radius:4px;color:#fff;background:#6b7280;font:700 10px/1 Arial,sans-serif}.mark img{width:100%;height:100%;object-fit:cover}
        .google .mark{background:#4285f4}.baidu .mark{background:#2932e1}.google-scholar .mark{background:#5f6368;font-size:9px}.duckduckgo .mark{background:#de5833}.so .mark{background:#19a15f;font-size:9px}.sogou .mark{background:#ff5a34}.bing .mark{background:#1185e0}.yandex .mark{background:#ef3b3b}.google-ai .mark{background:#6b5ce7}.bilibili .mark{background:#00aeec}.xiaohongshu .mark{background:#ef4d62}.x .mark{background:#111}.youtube .mark{background:#f21f26}.zhihu .mark{background:#1777e6}.douyin .mark{background:#161823}.doubao .mark{background:#4f7cff}.deepseek .mark{background:#4d6bfe}.group .mark{color:#4b5563;background:#f1f2f4}
        .special-copy .mark{color:#fff;background:#6b7280}
        .special-notes .mark{color:#fff;background:#3e8f6c}
        .special-ask-ai .mark{color:#f5c56b;background:#19352c;font-size:9px}
        .name{max-width:94px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        @media (prefers-reduced-motion: reduce){.bar,.reveal-handle{transition:none}}
        .pinned-group-list{position:fixed;z-index:2147483647;display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:160px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);padding:4px;overflow-y:auto;border:1px solid rgba(17,24,39,.1);border-radius:7px;background:rgba(255,255,255,.98);box-shadow:0 12px 30px rgba(17,24,39,.16),0 2px 5px rgba(17,24,39,.06);backdrop-filter:blur(14px) saturate(1.1);-webkit-backdrop-filter:blur(14px) saturate(1.1);pointer-events:auto}
        .pinned-group-list[hidden]{display:none}.pinned-group-list .entry{width:100%;justify-content:flex-start}
        /* 右键搜索源图标后的打开方式菜单（与选区浮层同一套外观）。 */
        .qf-open-menu{position:fixed;z-index:2147483647;display:flex;flex-direction:column;min-width:118px;padding:4px;border:1px solid rgba(17,24,39,.1);border-radius:8px;background:rgba(255,255,255,.98);box-shadow:0 12px 30px rgba(17,24,39,.16),0 2px 5px rgba(17,24,39,.06);backdrop-filter:blur(14px) saturate(1.1);-webkit-backdrop-filter:blur(14px) saturate(1.1);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:auto}
        .qf-open-menu-item{display:flex;align-items:center;width:100%;min-height:26px;padding:0 8px;border:0;border-radius:5px;color:#33363d;background:transparent;font:600 11px/1.2 Inter,ui-sans-serif,sans-serif;text-align:left;white-space:nowrap;cursor:pointer}
        .qf-open-menu-item:hover{color:#17181c;background:#f1f2f4}
        .qf-open-menu-item:focus-visible{outline:2px solid #2f795b;outline-offset:-2px}
      </style>
      <section class="bar" aria-label="QuickFind 常驻搜索列表" data-i18n-aria-label="QuickFind 常驻搜索列表">
        <div class="bar-content">
          <div class="pinned-query-row"><input class="pinned-query" type="text" aria-label="当前搜索文本" data-i18n-aria-label="当前搜索文本" autocomplete="off" /><button class="pinned-open-mode" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"></path></svg></button></div>
          <div class="entries"></div>
        </div>
      </section>
      <div class="pinned-group-list" hidden></div>
      <button class="reveal-handle" type="button" aria-label="展开常驻搜索栏" data-i18n-aria-label="展开常驻搜索栏" aria-expanded="false" title="展开常驻搜索栏" data-i18n-title="展开常驻搜索栏"></button>
    `;
    applyI18n(root);
    const bar = root.querySelector('.bar');
    const pinnedQuery = root.querySelector('.pinned-query');
    const pinnedOpenMode = root.querySelector('.pinned-open-mode');
    const pinnedGroupList = root.querySelector('.pinned-group-list');
    const revealHandle = root.querySelector('.reveal-handle');
    const resumePinnedBarCollapseAfterEditing = () => {
      window.setTimeout(() => {
        if (isEditingPinnedQuery()) return;
        pinnedCollapsePaused = false;
        schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
      }, 0);
    };
    pinnedQuery.addEventListener('compositionstart', () => {
      pinnedQueryComposing = true;
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
    });
    pinnedQuery.addEventListener('compositionend', () => {
      pinnedQueryComposing = false;
      resumePinnedBarCollapseAfterEditing();
    });
    pinnedQuery.addEventListener('input', () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
      // 只读一次 DOM 值供下面共用：pinnedQuery 是未标注的 Element，
      // 每引用一次 .value 都会各记一个类型错误，这里合并成一次读取。
      const nextValue = String(pinnedQuery.value);
      // 记下用户手打的内容：常驻栏每次重绘都会重算输入框的值，没有这份记忆，
      // 输入框一旦失焦（点页面别处、自动收起）就会被历史兜底值冲掉。
      // 主动清空则连同选区记忆一起作废，并标记「用户清空过」——
      // 否则下一次重渲染会被当成「还没填过」，把旧值或兜底值又填回来。
      pinnedDraftQuery = nextValue;
      if (!nextValue.trim()) {
        pinnedDraftQuery = '';
        pinnedSelectionQuery = '';
        pinnedUserCleared = true;
      } else {
        pinnedUserCleared = false;
      }
      const site = getPinnedSite();
      const siteInput = site?.selectorConfigured === false ? null : site ? findVisibleInput(site.selector) : null;
      if (!siteInput || siteInput.value === nextValue) return;
      siteInput.value = nextValue;
      siteInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pinnedOpenMode.addEventListener('click', () => setPinnedOpenInNewTab(!getPinnedOpenInNewTab()));
    syncPinnedOpenModeButton(root);
    const expandPinnedBar = () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
      setPinnedBarCollapsed(false, getPinnedSite());
    };
    revealHandle.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') expandPinnedBar();
    });
    revealHandle.addEventListener('focus', expandPinnedBar);
    revealHandle.addEventListener('click', expandPinnedBar);
    // 坐标热区：仅靠把手自身的 pointerenter 覆盖不到「鼠标横向移到图标位置」这条路径
    // （用户看到顶部有栏、直接去点图标，指针可能从把手侧面掠过、甚至跳过它）。
    // 指针一旦进入「展开后会占据的区域」，就把栏展开——此后点击自然落到按钮上。
    //
    // 收起侧同样按坐标判定，不能只靠 pointerleave。原因：重渲染会 replaceChildren 掉指针
    // 正悬停的那个按钮，浏览器此刻就补发一次 pointerleave（那时指针还真的在栏内，被正确
    // 忽略掉），等用户真正把指针移开时已经没有第二次 pointerleave 了 —— 收起永远排不上，
    // 栏就再也不自动收。按坐标判定对「事件被重渲染吃掉」这种情况免疫。
    //
    // 状态与元素一律就地查询，不引用模块级变量：`let pinnedHost = null` 这类声明
    // 在类型上永远是隐式 any，每引用一次就给类型债务加一个数（见 README 的记账口径）。
    // 折叠态的 clientY 早退保留在最前面：pointermove 频率很高，绝大多数事件在页面中部。
    // 坐标热区只覆盖把手本身（52×24），不再向下方扩张——此前允许「栏下沿 98px 以内」都算
    // 命中，于是鼠标划过页面顶部就会把栏勾出来，即用户说的「响应的范围过大」。
    // 代价是「鼠标直达图标位置」那条路径不再成立，改为先划过把手展开、再点图标。
    //
    // 热区矩形取自把手元素、不是宿主：宿主现在收起态也保持整条栏的宽度（见上面的注释），
    // 拿它当热区等于把整条栏的宽度都判成可展开，用户感知就是「响应范围过大」复发。
    window.addEventListener('pointermove', (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      // 采样指针坐标：重渲染补发的 pointerleave 没有可信坐标，收起判定要用这一份。
      pinnedPointerX = event.clientX;
      pinnedPointerY = event.clientY;
      const hostEl = document.getElementById('quickfind-pinned-search-host');
      if (!hostEl) return;
      if (hostEl.classList.contains('is-collapsed')) {
        const hot = pinnedRevealHotRect();
        if (!hot || !hot.width) return;
        const inside = event.clientX >= hot.left && event.clientX <= hot.right
          && event.clientY >= hot.top && event.clientY <= hot.bottom;
        if (inside) expandPinnedBar();
        return;
      }
      // 展开态：指针已离开栏与飞层，恢复自动收起。
      if (!pinnedCollapsePaused || isEditingPinnedQuery()) return;
      if (pointerOverPinnedHost()) return;
      pinnedCollapsePaused = false;
      schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
    }, { capture: true, passive: true });
    bar.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch') {
        pinnedCollapsePaused = true;
        clearPinnedCollapseTimer();
      }
    });
    // 指针按下的窗口必须显式记录。按钮会在按下与抬起之间被重渲染换掉，若此时排定收起，
    // 用户还没抬手栏就开始收——见 pinnedPointerHeld 的说明。
    // 用一个标注了 any 的形参承接宿主：直接写 `bar.addEventListener` 会让这个隐式 any 的
    // 模块变量多记一次引用，推高类型债务（见 README 的记账口径）。
    const holdPointerOnPress = (target: any) => {
      target.addEventListener('pointerdown', () => {
        pinnedPointerHeld = true; pinnedCollapsePaused = true; clearPinnedCollapseTimer();
      });
    };
    holdPointerOnPress(bar);
    holdPointerOnPress(pinnedGroupList);
    // 抬起、取消、指针离开窗口都要复位；漏掉任何一条都会让栏永远不再自动收起。
    const releasePinnedPointer = () => { pinnedPointerHeld = false; };
    window.addEventListener('pointerup', releasePinnedPointer, { capture: true });
    window.addEventListener('pointercancel', releasePinnedPointer, { capture: true });
    window.addEventListener('blur', releasePinnedPointer);
    bar.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      // 重渲染换掉宿主时浏览器会补发一次 pointerleave，坐标其实还在栏内 —— 用坐标复核。
      if (shouldHoldPinnedBar()) return;
      pinnedCollapsePaused = false;
      schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
    });
    bar.addEventListener('focusin', () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
    });
    bar.addEventListener('focusout', () => {
      // 自己重渲染引起的 focusout 不是「用户移开焦点」，跳过。
      if (Date.now() < pinnedFocusoutSuppressUntil) return;
      if (shouldHoldPinnedBar()) return;
      if (root.activeElement && bar.contains(root.activeElement)) return;
      pinnedCollapsePaused = false;
      schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
    });
    pinnedGroupList.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch') {
        pinnedCollapsePaused = true;
        clearPinnedCollapseTimer();
      }
    });
    pinnedGroupList.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      // 飞层与常驻栏是两块相邻矩形，从其一移到其二是正常操作，不该收起。
      if (shouldHoldPinnedBar()) return;
      pinnedCollapsePaused = false;
      schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
    });
    return pinnedHost;
  }

  function syncPinnedOpenModeButton(root = pinnedHost?.shadowRoot) {
    const button = root?.querySelector('.pinned-open-mode');
    if (!button) return;
    const openInNewTab = getPinnedOpenInNewTab();
    const label = openInNewTab
      ? t('搜索结果将在新标签页打开；点击改为当前页面打开')
      : t('搜索结果将在当前页面打开；点击改为新标签页打开');
    button.setAttribute('aria-pressed', String(openInNewTab));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  /**
   * 「这次 focusout 是自己重渲染引起的」的判定窗口。
   *
   * replaceChildren 移除持有焦点的按钮后，focusout 可能同步派发、也可能排在微任务里，
   * 各实现不一致。给一个几百毫秒的窗口把所有情况都盖住；窗口内还叠加坐标复核，
   * 所以即便用户真的在同一瞬间移开指针，也不会被这个窗口误留下。
   */
  const PINNED_FOCUSOUT_GRACE_MS = 400;

  function getPinnedQueryInput() {
    return pinnedHost?.shadowRoot?.querySelector('.pinned-query') || null;
  }

  function isEditingPinnedQuery() {
    const pinnedQuery = getPinnedQueryInput();
    return pinnedQueryComposing || Boolean(pinnedQuery && pinnedHost?.shadowRoot?.activeElement === pinnedQuery);
  }

  /**
   * 收起态的展开热区矩形 —— 就是把手本身那块 52×24 的区域。
   *
   * 为什么不直接用宿主矩形：宿主在收起态也保持整条栏的宽度（见 ensurePinnedHost 里的注释，
   * 收窄宿主会让收起动画横向跳变）。若拿宿主矩形当热区，整条栏宽 × 24px 全变成可展开区，
   * 「鼠标划过页面顶部就把栏勾出来」的旧缺陷会原样复发。
   * 取把手元素自己的矩形，热区面积与早前「收窄宿主」方案逐像素一致。
   */
  function pinnedRevealHotRect() {
    const el = document.getElementById('quickfind-pinned-search-host');
    if (!el || !el.isConnected) return null;
    const handle: Element | null = el.shadowRoot?.querySelector('.reveal-handle') || null;
    return handle ? handle.getBoundingClientRect() : null;
  }

  /**
   * 指针是否停在常驻栏自己身上，或正按在它上面。
   *
   * 自动收起的早退条件。光靠 pointerleave / focusout 不够可靠：重渲染会在指针仍位于栏上时
   * 把宿主整层换掉，浏览器补发的 pointerleave / focusout 会被误当成「用户离开了」。
   * 所以此外还按坐标复核一次——指针真的还在栏的矩形内就不收起。
   *
   * 飞层（`.pinned-group-list`）是 position:fixed 的、刻意落在宿主矩形之外（见
   * positionPinnedGroupList），但它同样是「栏的一部分」。只认宿主矩形会把「从栏移进飞层」
   * 误判成离开，所以两个矩形都算。
   *
   * 坐标取自模块级的 number 状态、宿主就地查询，都不经事件参数：事件对象的 pointerType /
   * clientX 在未标注的监听器里类型收不窄，读它们会给类型债务记账（见 README 的记账口径）。
   */
  function pointerOverPinnedHost() {
    if (pinnedPointerHeld) return true;
    if (pinnedPointerX < 0) return false;
    const el = document.getElementById('quickfind-pinned-search-host');
    if (!el || !el.isConnected) return false;
    const inside = (rect: DOMRect | null) => Boolean(rect && rect.width && rect.height
      && pinnedPointerX >= rect.left && pinnedPointerX <= rect.right
      && pinnedPointerY >= rect.top && pinnedPointerY <= rect.bottom);
    if (inside(el.getBoundingClientRect())) return true;
    const groupList: Element | null = el.shadowRoot?.querySelector('.pinned-group-list') || null;
    if (groupList && !groupList.hasAttribute('hidden')) return inside(groupList.getBoundingClientRect());
    // 右键菜单同样浮在宿主矩形之外，指针移到菜单上不该被当成「离开常驻栏」而收起。
    const openMenu = el.shadowRoot?.querySelector('.qf-open-menu') || null;
    if (openMenu) return inside(openMenu.getBoundingClientRect());
    return false;
  }

  /**
   * 是否应当推迟常驻栏的自动收起。
   *
   * 两种情况都算「用户还在用它」：正在输入框里打字、指针还按在栏上或停在栏（含飞层）的矩形内。
   * 收起的排定统一挂在这一处判定上，避免每个事件处理器各写一遍而漏掉其中一条。
   */
  function shouldHoldPinnedBar() {
    if (isEditingPinnedQuery()) return true;
    return pointerOverPinnedHost();
  }

  // 历史记录里的最近一次搜索：拿不到页面搜索框和 URL 查询时，常驻栏用它兜底显示。
  // 历史里可能存着从编码 URL 抄来的 %XX 串（见 getPinnedQueryFromUrl），显示前还原一次，
  // 否则它会作为兜底值出现在每个没有查询的页面上。
  function getPinnedHistoryQuery() {
    const history = Array.isArray(settings?.searchHistory) ? settings.searchHistory : [];
    return decodeQueryText(String(history.map((item) => typeof item === 'string' ? item : item?.query).find(Boolean) || ''));
  }

  // site 的形状见 getPinnedSite()，本文件补齐类型标注时统一收敛到 shared/settings.ts。
  function pinnedSiteInputFor(site: any) {
    return site?.selectorConfigured === false ? null : site ? findVisibleInput(site.selector) : null;
  }

  function syncPinnedQuery(site) {
    const pinnedQuery = getPinnedQueryInput();
    if (!pinnedQuery || pinnedHost?.shadowRoot?.activeElement === pinnedQuery) return;
    const siteInput = pinnedSiteInputFor(site);
    const urlQuery = getPinnedQueryFromUrl(site);
    const realQuery = String(siteInput?.value || '').trim() || urlQuery;
    // 页面出现了「新的」真实查询：以页面为准，之前留下的草稿/选区值作废。
    // 「新的」的判定要排除用户自己那次同步——常驻框输入会写回页面搜索框，随后 document 上的
    // input 监听再调进来，此时 realQuery 虽然变了却仍是用户正在打的内容，丢弃草稿等于把他的话清掉。
    const userAuthored = pinnedDraftQuery && realQuery === pinnedDraftQuery.trim();
    if (realQuery && realQuery !== pinnedSyncedRealQuery && !userAuthored) {
      pinnedDraftQuery = '';
      pinnedSelectionQuery = '';
      pinnedUserCleared = false;
    }
    pinnedSyncedRealQuery = realQuery;
    // 用户主动清空过：保持空框，直到页面出现新的真实查询（上面那道闸已把标记清掉）
    // 或用户重新输入。少了这一条，清空在结果页上会被页面查询值立刻填回来。
    if (pinnedUserCleared) return;
    if (!realQuery) {
      // 页面本身没有查询内容时，用户留下的值优先于历史兜底值。
      // 选区自动填入的值要留住：重渲染（展开更多、路由变化）会把它当成空值、
      // 用「上一次搜索」覆盖回去，所以在这里直接用记忆值回填。
      const remembered = pinnedDraftQuery || pinnedSelectionQuery;
      if (remembered) {
        // 记忆值含用户可能打出的尾随空格，而输入框里显示的通常是 trim 过的，
        // 所以按 trim 后比较、以原始值回填，避免无谓的赋值把光标顶到末尾。
        if (pinnedQuery.value.trim() !== remembered.trim()) pinnedQuery.value = remembered;
        return;
      }
      pinnedQuery.value = getPinnedHistoryQuery() || '';
      return;
    }
    // 页面有真实查询：用户正在改写的草稿优先，避免重渲染把改写退回原查询。
    if (pinnedDraftQuery && pinnedQuery.value.trim() !== pinnedDraftQuery.trim()) pinnedQuery.value = pinnedDraftQuery;
    else if (!pinnedDraftQuery) pinnedQuery.value = siteInput?.value || urlQuery || '';
  }

  function getPinnedQueryFromUrl(site) {
    if (!site) return '';
    const keys = [...new Set(['q', 'keyword', ...(Array.isArray(site.queryKeys) ? site.queryKeys : [])].map((key) => String(key).toLowerCase()))];
    const queryParts = [location.search];
    const hashQueryIndex = location.hash.indexOf('?');
    if (hashQueryIndex >= 0) queryParts.push(location.hash.slice(hashQueryIndex));
    else if (/^#[^/=?&]+=/i.test(location.hash)) queryParts.push(location.hash.slice(1));
    const paramsList = queryParts.filter(Boolean).map((query) => new URLSearchParams(query));
    for (const key of keys) {
      for (const params of paramsList) {
        const match = Array.from(params.entries()).find(([name, value]) => name.toLowerCase() === key && value.trim());
        // URLSearchParams 只解一层百分号编码；双重编码的地址解出来仍是 %XX 串，再还原一次。
        if (match) return decodeQueryText(match[1].trim());
      }
    }
    if (site.pathHasMarker) {
      let pathname = location.pathname || '/';
      try { pathname = decodeURIComponent(pathname); } catch { /* keep encoded path */ }
      pathname = decodeQueryText(pathname);
      const prefix = String(site.pathPrefix || ''), suffix = String(site.pathSuffix || '');
      if (pathname.toLowerCase().startsWith(prefix.toLowerCase()) && pathname.toLowerCase().endsWith(suffix.toLowerCase())) {
        const value = pathname.slice(prefix.length, pathname.length - suffix.length || undefined);
        if (value && value.toLowerCase() !== '__quickfind_query__') return decodeQueryText(value);
      }
    }
    return '';
  }

  function getPinnedQuery(site) {
    const pinnedQuery = getPinnedQueryInput();
    if (pinnedQuery) return pinnedQuery.value.trim();
    return site?.selectorConfigured === false ? '' : findVisibleInput(site.selector)?.value.trim() || '';
  }

  /**
   * 点搜索源时实际使用的查询词。
   *
   * 常驻框为空不能直接放弃：此时页面自己往往有查询——视频站顶栏搜索框里的词、
   * 或结果页 URL 里的参数。用户点图标的本意是「搜索我现在关注的内容」，
   * 而页面上的那个词正是它。此前空框只把焦点丢回输入框（`if (!query) return …focus()`），
   * 在视频站上就表现为「点搜索图标没反应」。
   *
   * 优先级与常驻框的取值口径一致（见 syncPinnedQuery）：框内 → 页面搜索框 → URL。
   * 参数显式标注 `any`：本文件尚未补齐类型，未标注的参数每处都记一个隐式 any。
   */
  function resolvePinnedSearchQuery(site: any) {
    const fromBox = getPinnedQuery(site);
    if (fromBox) return fromBox;
    const fromPage = String(findVisibleInput(site?.selector)?.value || '').trim();
    if (fromPage) return fromPage;
    return getPinnedQueryFromUrl(site);
  }

  // 常驻搜索框本来没有内容时，把页面上新选中的文字填进去：选中的文字本身就是想搜的内容。
  // 只认「空」和「上一次搜索」的兜底填充这两种情况，页面搜索框里的值、URL 里的查询参数
  // 以及用户自己的输入都不覆盖；写入的值交给 syncPinnedQuery 保护，直到页面出现真实查询。
  function applySelectionToPinnedQuery() {
    const pinnedQuery = getPinnedQueryInput();
    if (!pinnedQuery || !settings?.enabled) return;
    if (isEditingPinnedQuery()) return;
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > 5000) return;
    const site = getPinnedSite();
    if (!site) return;
    if (String(pinnedSiteInputFor(site)?.value || '').trim() || getPinnedQueryFromUrl(site)) return;
    const current = pinnedQuery.value.trim();
    if (current && current !== getPinnedHistoryQuery()) return;
    if (current === text) return;
    pinnedDraftQuery = '';
    pinnedUserCleared = false;
    pinnedSelectionQuery = text;
    pinnedQuery.value = text;
  }

  /**
   * 顶栏那排小图标的节点缓存。
   *
   * 为什么复用 <img> 而不是每次新建：任何一次结构重建（换配置、展开「更多」、页面变动
   * 触发的重绘）都会 replaceChildren 掉整排按钮，新建的 <img> 要重新解码/重新上传纹理。
   * 单看一枚 17px 的图标微不足道，但一排十几枚在同一次重建里全部换新，图标区会先白一帧
   * ——用户看到的就是「顶栏小图标闪一下」。
   *
   * 键里带条目 id：同一个搜索源可以同时出现在直排区和分组飞层里，而同一个节点不能有两个
   * 父节点（第二次 append 会把它从第一个按钮里移走）。所以同一次渲染里用过的节点不再复用，
   * 撞上就退回新建，与旧实现一致。
   */
  const pinnedIconNodes = new Map<string, HTMLImageElement>();
  /** 加载失败过的图标地址：后续渲染直接用工整的文字标记，不必反复建 <img> 触发失败。 */
  const pinnedIconFailures = new Set<string>();

  /** 把一枚搜索源的图标放进 .mark / .engine-mark 容器里。used 是本次渲染已占用的节点。 */
  function fillIconMark(mark: HTMLElement, entry: any, used: Set<HTMLImageElement>) {
    const url = String(entry.iconUrl || '');
    // 分组入口的角标是界面文案（'组'），随语言变化；搜索源的 mark 是用户数据，原样显示。
    const fallback = entry.isGroup ? t('组') : String(entry.mark || '?');
    if (!url || pinnedIconFailures.has(url)) { mark.textContent = fallback; return; }
    const key = `${entry.id}\u0001${url}`;
    let image = pinnedIconNodes.get(key);
    if (!image || used.has(image)) {
      const created = document.createElement('img');
      created.src = url;
      created.alt = '';
      // 解码放到下一个任务，避免重建时同步解码把这一帧顶掉。
      created.decoding = 'async';
      created.addEventListener('error', () => {
        pinnedIconNodes.delete(key);
        pinnedIconFailures.add(url);
        const holder = created.parentElement;
        created.remove();
        if (holder && !holder.childElementCount) holder.textContent = fallback;
      });
      pinnedIconNodes.set(key, created);
      // 缓存只服务于复用，条目总有上限；异常多的自定义图标不至于让它无限长。
      if (pinnedIconNodes.size > 240) pinnedIconNodes.clear();
      image = created;
    }
    used.add(image);
    mark.append(image);
  }

  /**
   * 左键点图标与右键菜单共用的一条打开路径。
   *
   * 目标标签页由调用方决定：左键用常驻栏的默认开关，右键菜单按用户那一次的选择。
   * 其余行为（没有查询词时把焦点交给输入框、特殊功能、记历史）两边必须完全一致，
   * 所以合并在这里，而不是让菜单另抄一份。
   */
  function activatePinnedEntry(entry, site, openInNewTab) {
    const pageInput = findVisibleInput(site.selector);
    const query = resolvePinnedSearchQuery(site);
    // 三处都没有查询词时才把焦点交给输入框：让用户先打词再搜。
    // 只要页面或地址里有词就走搜索——此前只读常驻框，空框在视频站上
    // 表现为「点图标没反应」，而页面上明明有可搜的内容。
    if (!query) {
      // 优先常驻框。`a?.focus() || b?.focus()` 这个写法是错的：Element.focus() 返回
      // undefined，`||` 会继续求值，焦点被无条件交给页面搜索框——用户点的明明是
      // 扩展的图标，光标却跑到站点输入框里。focus() 不抛错就视为成功，显式 return。
      const ownInput = getPinnedQueryInput();
      if (ownInput) { ownInput.focus(); return; }
      pageInput?.focus();
      return;
    }
    if (entry.isSpecial) {
      if (entry.action === 'copy') void copyTextToClipboard(query);
      else if (entry.action === 'notes') saveTextToOutlineNotes(query);
      else if (entry.action === 'ask-ai') askAiFromAction(query);
      return;
    }
    rememberSearch(query);
    const url = getSearchUrl(entry, query);
    if (openInNewTab) openPinnedSearchInNewTab(url);
    else window.location.assign(url);
  }

  function createPinnedButton(entry, site, allowIconOnly = true, usedIcons = new Set<HTMLImageElement>()) {
    const button = document.createElement('button');
    button.type = 'button';
    const iconOnly = allowIconOnly && !entry.isGroup && (entry.iconOnly === true || getPinnedConfig().iconOnly?.[entry.id] === true);
    button.className = 'entry ' + entry.className + (iconOnly ? ' icon-only' : '');
    const displayName = entry.isGroup ? groupLabel({ id: entry.groupId, name: entry.name }) : entry.isSpecial ? actionLabel(entry) : sourceLabel(entry);
    button.title = entry.isGroup ? t('展开{n}', { n: displayName }) : entry.isSpecial ? actionTooltip(entry) : t('使用{n}搜索', { n: displayName });
    if (entry.isGroup) {
      button.dataset.groupId = entry.groupId;
      button.setAttribute('aria-expanded', String(pinnedExpandedGroupId === entry.groupId));
    }
    const mark = document.createElement('span');
    mark.className = 'mark';
    fillIconMark(mark, entry, usedIcons);
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = displayName;
    button.append(mark, name);
    button.addEventListener('click', () => {
      if (entry.isGroup) {
        pinnedMoreExpanded = false;
        pinnedExpandedGroupId = pinnedExpandedGroupId === entry.groupId ? null : entry.groupId;
        renderPinnedBar(site);
        positionPinnedBar(site);
        return;
      }
      activatePinnedEntry(entry, site, getPinnedOpenInNewTab());
    });
    // 右键：按次挑「本标签打开 / 新建标签打开」。分组与特殊功能不是 URL 搜索，保留原生菜单。
    button.addEventListener('contextmenu', (event) => {
      if (entry.isGroup || entry.isSpecial) return;
      // 没有可搜的词时「打开」没有意义，菜单出来也只会让用户多按一次：交给左键的聚焦路径。
      if (!resolvePinnedSearchQuery(site)) return;
      event.preventDefault();
      event.stopPropagation();
      showOpenModeMenu(button.getRootNode(), { x: event.clientX, y: event.clientY }, [
        { label: t('本标签打开'), run: () => activatePinnedEntry(entry, site, false) },
        { label: t('新建标签打开'), run: () => activatePinnedEntry(entry, site, true) }
      ]);
    });
    return button;
  }

  function createPinnedMoreButton(site) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entry group';
    button.dataset.pinnedMore = 'true';
    button.setAttribute('aria-expanded', String(pinnedMoreExpanded));
    button.title = pinnedMoreExpanded ? t('收起更多搜索源') : t('展开更多搜索源');
    const mark = document.createElement('span');
    mark.className = 'mark'; mark.textContent = pinnedMoreExpanded ? '⌃' : '…';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = pinnedMoreExpanded ? t('收起') : t('更多');
    button.append(mark, name);
    button.addEventListener('click', () => {
      pinnedExpandedGroupId = null;
      pinnedMoreExpanded = !pinnedMoreExpanded;
      renderPinnedBar(site);
      positionPinnedBar(site);
    });
    return button;
  }

  /**
   * 常驻栏的结构指纹：只有它变了才重建按钮 DOM。
   *
   * 为什么必须有这道闸：页面 DOM 一变就会走到 mountPinnedBar，而 mountPinnedBar 原先无条件
   * 重建按钮。实测动态页面（结果流、埋点持续增删节点）下 `.entries` 每秒被整体替换 6 次以上，
   * 于是出现两类缺陷：
   *   1) 用户按下与抬起之间跨过一次替换，两个事件落在不同元素上，`click` 不派发 ——
   *      表现为「点图标没反应」，且是否命中取决于按压时长，所以只有「部分」图标中招；
   *   2) 被替换掉的按钮正持有焦点，浏览器随即在 `.bar` 上派发 focusout，收起排定被挂上 ——
   *      表现为「点一下分组，一秒后栏自己收起」（实测事件序列 focusin → focusout）。
   *
   * 指纹覆盖一切影响呈现的字段，少一个都会让界面停在旧状态。
   */
  function pinnedRenderSignatureFor(site: any, directEntries: any[], hiddenEntries: any[], groupEntries: any[], expandedGroupId: any, moreExpanded: any) {
    const iconOnlyMap = getPinnedConfig().iconOnly;
    const describe = (entry: any, allowIconOnly: boolean) => {
      const iconOnly = allowIconOnly && !entry.isGroup
        && (entry.iconOnly === true || iconOnlyMap?.[entry.id] === true);
      return [
        entry.id, entry.isGroup ? 'g' : '', entry.groupId || '', entry.isSpecial ? 's' : '',
        entry.action || '', entry.name, entry.mark || '', entry.className || '',
        entry.iconUrl || '', iconOnly ? '1' : '0', entry.specialTitle || '',
      ].join('\u0001');
    };
    return [
      // 语言影响名字与提示，必须进指纹，否则切换后常驻栏停在旧语言。
      getLocale(),
      site?.id || '', site?.selector || '', site?.host || '', String(site?.selectorConfigured),
      String(getPinnedDefaultGroupCount()), String(moreExpanded), String(expandedGroupId || ''),
      directEntries.map((entry: any) => describe(entry, true)).join('\u0002'),
      hiddenEntries.map((entry: any) => describe(entry, true)).join('\u0002'),
      groupEntries.map((entry: any) => describe(entry, false)).join('\u0002'),
    ].join('\u0003');
  }

  /** 与结构无关的收尾：显隐、模式按钮、栏高。重建与跳过两条路径都要走。 */
  function refreshPinnedBarChrome(root: any) {
    const entries = root?.querySelector('.entries');
    setPinnedHostVisible(Boolean(entries?.childElementCount));
    syncPinnedOpenModeButton(root);
    syncPinnedBarHeight(root);
  }

  function renderPinnedBar(site) {
    const root = ensurePinnedHost().shadowRoot;
    const entries = root.querySelector('.entries');
    const groupList = root.querySelector('.pinned-group-list');
    const allEntries = getPinnedEntries();
    const directEntries = allEntries.slice(0, getPinnedDefaultGroupCount());
    const hiddenEntries = allEntries.slice(directEntries.length);
    // 输入框取值与结构无关，但会随页面查询、草稿、清空状态变化，每次都要同步（含跳过重建这条路径）。
    //
    // 收起态例外：这个框此刻既看不见也点不到，没有人的眼睛在等它。而同步一次要调
    // findVisibleInput——querySelectorAll + 每个候选一次 getBoundingClientRect/getComputedStyle，
    // 是这条 120ms 路径上最后剩下的一次强制布局。收起态跳过，展开时补同步（见 setPinnedBarCollapsed）。
    if (!pinnedBarCollapsed) syncPinnedQuery(site);
    const groupEntries = pinnedMoreExpanded
      ? hiddenEntries
      : pinnedExpandedGroupId ? getPinnedGroupSources(pinnedExpandedGroupId) : [];
    const signature = pinnedRenderSignatureFor(site, directEntries, hiddenEntries, groupEntries, pinnedExpandedGroupId, pinnedMoreExpanded);
    if (signature === pinnedRenderSignature) {
      refreshPinnedBarChrome(root);
      return;
    }
    pinnedRenderSignature = signature;
    // 结构要重建，高度必然要重量（内容和按钮数都换了）。
    pinnedBarContentHeightDirty = true;
    // 紧随其后的 replaceChildren 会把持有焦点的按钮移出文档，浏览器随即在 .bar 上派发 focusout。
    // 那是重建的副产物、不是用户移开焦点，用时间窗标出来供 focusout 监听跳过。
    pinnedFocusoutSuppressUntil = Date.now() + PINNED_FOCUSOUT_GRACE_MS;
    // 图标节点按「本次渲染已占用」去重，见 fillIconMark。
    const usedIcons = new Set<HTMLImageElement>();
    entries.replaceChildren();
    directEntries.forEach((entry) => entries.append(createPinnedButton(entry, site, true, usedIcons)));
    if (hiddenEntries.length) entries.append(createPinnedMoreButton(site));
    groupList.replaceChildren();
    groupEntries.forEach((entry) => groupList.append(createPinnedButton(entry, site, false, usedIcons)));
    groupList.hidden = !groupList.childElementCount;
    // 按钮数变了，宿主宽度也就变了：横向位置要重新量。放在重建之后立位，
    // 让紧随其后的 refreshPinnedBarChrome / positionPinnedBar 各自只量一次。
    pinnedBarHostWidthDirty = true;
    refreshPinnedBarChrome(root);
  }

  /**
   * `.bar` 的边框宽度。与下面模板里 `--pinned-bar-border-size` 的取值必须一致。
   *
   * 原先这里是 `getComputedStyle(bar).getPropertyValue('--pinned-bar-border-size')`：
   * 每次渲染都为一个常量做一次样式解析，而样式解析同样会打断渲染流水线。
   * 这是代码里写死的 1px，直接当常量用。
   */
  const PINNED_BAR_BORDER_SIZE = 1;

  function syncPinnedBarHeight(root = pinnedHost?.shadowRoot) {
    // 只有内容结构或展开态变过才重量：.bar 的高度过渡读的就是这个变量，
    // 而在「页面持续变动 → 每 120ms 挂载一次」的稳态下，内容根本没变，
    // 每次读 scrollHeight 都是白付一次强制布局。
    if (!pinnedBarContentHeightDirty) return;
    // 宿主隐藏时整棵子树不参与布局，scrollHeight 恒为 0 —— 这时候量出来的数不能当真，
    // 保留 dirty 让下次可见时再量。
    if (pinnedHost?.hidden) return;
    const bar = root?.querySelector('.bar');
    const content = root?.querySelector('.bar-content');
    if (!bar || !content) return;
    pinnedBarContentHeight = Math.ceil(content.scrollHeight + PINNED_BAR_BORDER_SIZE * 2);
    pinnedBarContentHeightDirty = false;
    bar.style.setProperty('--pinned-bar-height', `${pinnedBarContentHeight}px`);
  }

  function clearPinnedCollapseTimer({ resetDeadline = true } = {}) {
    if (pinnedCollapseTimer) window.clearTimeout(pinnedCollapseTimer);
    pinnedCollapseTimer = null;
    if (resetDeadline) pinnedCollapseDeadline = 0;
  }

  function schedulePinnedBarCollapse(site, { restart = false } = {}) {
    clearPinnedCollapseTimer({ resetDeadline: false });
    if (!pinnedHost || pinnedBarCollapsed || pinnedCollapsePaused || isEditingPinnedQuery()) return;
    const configuredDelay = Number(getPinnedConfig().collapseDelay);
    const delay = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(60000, configuredDelay)) : DEFAULT_PINNED_SEARCH.collapseDelay;
    if (restart || !pinnedCollapseDeadline) pinnedCollapseDeadline = Date.now() + delay;
    const remaining = Math.max(0, pinnedCollapseDeadline - Date.now());
    pinnedCollapseTimer = window.setTimeout(() => {
      pinnedCollapseTimer = null;
      pinnedCollapseDeadline = 0;
      setPinnedBarCollapsed(true, site || getPinnedSite());
    }, remaining);
  }

  /**
   * 常驻栏飞层（分组展开的列表）定位。
   *
   * **紧贴被触发图标的侧边展开**，与图标同高——用户明确要求「显示在分组图标的旁边」，
   * 落在整条栏下方（旧实现）视觉上像「栏底下又长出一块」，与点击图标的动作对不上。
   *
   * 已知代价（用户明确接受）：飞层宽 170px，从图标右缘起画会盖住同一行右侧的分组图标
   * ——实测最多盖住 3 个。被盖住的图标在那段时间里不可点，用户若凭记忆去点它，
   * 命中的是飞层里的条目、会跳到搜索引擎。这正是早前「点分组没反应 / 点错源」的成因，
   * 旧版本靠「落到栏下方」规避；现在改回侧边展开，即以该缺陷换位置贴合度。
   * 右侧放不下就翻到图标左侧，两侧都放不下再夹回视口内。
   */
  function positionPinnedGroupList() {
    if ((!pinnedExpandedGroupId && !pinnedMoreExpanded) || !pinnedHost) return;
    const root = pinnedHost.shadowRoot;
    const groupList = root?.querySelector('.pinned-group-list');
    if (!groupList || groupList.hidden) return;
    const moreButton = root.querySelector('.entry[data-pinned-more="true"]');
    const triggerButton = pinnedMoreExpanded
      ? moreButton
      : Array.from(root.querySelectorAll('.entries .entry[data-group-id]')).find((button) => button.dataset.groupId === pinnedExpandedGroupId) || moreButton;
    if (!triggerButton) { groupList.hidden = true; return; }
    const buttonRect = triggerButton.getBoundingClientRect();
    const flyoutWidth = Math.min(groupList.offsetWidth || 160, window.innerWidth - 20);
    const flyoutHeight = Math.min(groupList.offsetHeight || 36, window.innerHeight - 20);
    // 水平：优先紧贴图标右缘，右侧放不下翻到左缘。
    let left = buttonRect.right + 6;
    if (left + flyoutWidth > window.innerWidth - 10) left = buttonRect.left - flyoutWidth - 6;
    left = Math.max(10, Math.min(window.innerWidth - flyoutWidth - 10, left));
    // 垂直：与触发图标同高（不是栏下沿），这样它看起来就是「从这个图标长出去的」。
    const top = Math.max(10, Math.min(window.innerHeight - flyoutHeight - 10, buttonRect.top));
    groupList.style.left = `${left}px`;
    groupList.style.top = `${top}px`;
  }

  function setPinnedBarCollapsed(collapsed, site) {
    clearPinnedCollapseTimer();
    if (!pinnedHost) return;
    const stateChanged = pinnedBarCollapsed !== collapsed;
    pinnedBarCollapsed = collapsed;
    if (collapsed) {
      // 收起后菜单失去依附对象，留着它就成了悬在页面顶部的一块死链接。
      // 只关常驻栏这一套里的菜单：收起是常驻栏的定时动作，浮层里正开着的菜单不由它负责。
      closeOpenModeMenuIn(pinnedHost.shadowRoot);
      pinnedExpandedGroupId = null;
      pinnedMoreExpanded = false;
      pinnedPointerHeld = false;
      if (site) renderPinnedBar(site);
    } else if (stateChanged && site) {
      // 展开这一下必须补一次渲染：收起态跳过了输入框同步（见 renderPinnedBar），
      // 而用户现在真的要看见这个框了。结构没变时指纹闸门会拦住重建，只做同步与 chrome 刷新。
      pinnedBarContentHeightDirty = true;
      renderPinnedBar(site);
    }
    pinnedHost.classList.toggle('is-collapsed', collapsed);
    const revealHandle = pinnedHost.shadowRoot?.querySelector('.reveal-handle');
    if (revealHandle) revealHandle.setAttribute('aria-expanded', String(!collapsed));
    positionPinnedBar(site);
    // 展开常驻栏不碰焦点：划过或点开常驻栏多半只是想把列表露出来，光标落进输入框会把焦点
    // 从页面原本正在操作的元素上拽走，还会让栏被判定成「正在编辑」而不再自动收起。
    // 框里已有内容（选区自动填入、上一次搜索的兜底值）也不聚焦——要直接回车搜索，
    // 点一下框就行，不需要替用户决定。
  }

  /**
   * 常驻栏宿主的显隐统一入口。
   *
   * 显示的三个动作必须成对出现：从 hidden 改为可见、提升到 top layer、补上 inline 定位。
   * 分散在四处各写一遍时，只要漏掉提升这一步，宿主在敌对页面上就会被透明埋点层压住；
   * 漏掉收回那一步，popover 会留在 top layer 一直挡着页面。
   */
  function setPinnedHostVisible(visible) {
    const el = pinnedHost;
    if (!el) return;
    // 只在状态真的翻转时才写：这段是高频路径（每次滚动、每次挂载都会经过）。
    if (el.hidden === visible) {
      el.hidden = !visible;
      // hidden 的元素量不出宽度（offsetWidth 恒为 0），重新可见后必须重量。
      if (visible) pinnedBarHostWidthDirty = true;
    }
    if (visible) promoteToTopLayer(el);
    else {
      // 宿主藏起来时菜单也跟着不可见。留在 DOM 里的那份（连同它那几条全局监听）会在宿主
      // 下次可见时原样浮出来——一个停在旧坐标、指向旧站点的死菜单，所以在这里一并拆掉。
      closeOpenModeMenuIn(el.shadowRoot);
      demoteFromTopLayer(el);
    }
  }

  function positionPinnedBar(site) {
    // 配置没到位之前一格都不画：settings 此刻还是 DEFAULT_SETTINGS 那份占位值，
    // 按它算出来的「这一页该不该有常驻栏、放哪些源」都不是用户的真实配置。
    // 这条早退挡的正是加载期那条路径：scroll / resize → refreshSelectionPosition →
    // positionPinnedBar 会先于 storage 回调执行（实测 70ms vs 75ms），
    // 于是宿主在 mountPinnedBar 之前就被建出来并显示了一帧。
    if (!pinnedSettingsReady) return null;
    const entriesAvailable = Boolean(site && getPinnedEntries().length && settings?.enabled);
    if (!entriesAvailable) {
      clearPinnedCollapseTimer();
      setPinnedHostVisible(false);
      return null;
    }
    const barHost = pinnedHost || ensurePinnedHost();
    if (!barHost.isConnected) document.documentElement.append(barHost);
    setPinnedHostVisible(true);
    // 展开态与收起态的 .bar 边框宽度不同（收起态是 0），量出来的宿主宽度差 2px。
    // 类名真的翻转时把测量结果作废，位置才和「当场重新量一次」的旧行为一致。
    const collapsedClass = barHost.classList.contains('is-collapsed');
    if (collapsedClass !== Boolean(pinnedBarCollapsed)) {
      barHost.classList.toggle('is-collapsed', pinnedBarCollapsed);
      pinnedBarHostWidthDirty = true;
    }
    if (pinnedBarHostWidthDirty || !pinnedBarHostWidth) {
      pinnedBarHostWidth = Math.min(barHost.offsetWidth || 420, window.innerWidth - 20);
      pinnedBarHostWidthDirty = false;
    }
    const left = Math.max(10, Math.min(window.innerWidth - pinnedBarHostWidth - 10, (window.innerWidth - pinnedBarHostWidth) / 2));
    const leftCss = `${left}px`;
    if (barHost.style.left !== leftCss) barHost.style.left = leftCss;
    if (barHost.style.top !== '0px') barHost.style.top = '0px';
    positionPinnedGroupList();
    return barHost;
  }

  function mountPinnedBar() {
    // settings 只是占位默认值时不许挂载：常驻栏的内容完全由配置决定，
    // 先按默认值画一遍再被真实配置改掉，等于让用户看两次不同的栏。
    if (!pinnedSettingsReady) return;
    const site = getPinnedSite();
    if (!site || !settings) {
      clearPinnedCollapseTimer();
      setPinnedHostVisible(false);
      pinnedMountedSiteId = null;
      pinnedMountedPageKey = '';
      return;
    }
    const pageKey = location.href;
    const isNewPage = pinnedMountedSiteId !== site.id || pinnedMountedPageKey !== pageKey;
    if (isNewPage) {
      clearPinnedCollapseTimer();
      pinnedMountedSiteId = site.id;
      pinnedMountedPageKey = pageKey;
      // 换页一律重建，不受指纹闸门约束。指纹只覆盖「站点解析结果 + 条目 + 展开状态」，
      // 换页时这些可能恰好相同（如同一站点内跳转），但按钮上挂的闭包仍指向旧页面上下文。
      pinnedRenderSignature = '';
      pinnedPointerHeld = false;
      if (!isEditingPinnedQuery()) {
        pinnedBarCollapsed = true;
        pinnedCollapsePaused = false;
        pinnedMoreExpanded = false;
        pinnedExpandedGroupId = null;
        pinnedSelectionQuery = '';
        pinnedDraftQuery = '';
        pinnedSyncedRealQuery = '';
        pinnedUserCleared = false;
      }
    }
    const host = ensurePinnedHost();
    // 换页时菜单必须作废：它的回调闭包攥着上一页的 site（站点解析结果、查询来源都在里面），
    // 坐标也是旧的。放在 ensurePinnedHost 之后，root 一定存在。
    if (isNewPage) closeOpenModeMenuIn(host.shadowRoot);
    host.classList.toggle('is-collapsed', pinnedBarCollapsed);
    host.shadowRoot?.querySelector('.reveal-handle')?.setAttribute('aria-expanded', String(!pinnedBarCollapsed));
    if (!host.isConnected) document.documentElement.append(host);
    renderPinnedBar(site);
    positionPinnedBar(site);
    if (!pinnedBarCollapsed && !isNewPage) schedulePinnedBarCollapse(site);
  }

  function schedulePinnedMount() {
    // 顺序不能反：防抖生效期间它每收到一次 DOM 变动就被调用一次，先判 timer 才能把
    // 站点解析压到「一次变动窗口一次」。mountPinnedBar 内部还有一次同样的判定，兜住
    // 这层早退漏掉的情况（例如排队期间 settings 变了）。
    if (pinnedMountTimer) return;
    if (!getPinnedSite({ requireSearchResults: false })) return;
    pinnedMountTimer = window.setTimeout(() => { pinnedMountTimer = null; mountPinnedBar(); }, 120);
  }

  function positionGroupEngineList() {
    if (!expandedGroupId || groupEngineList.hidden) return;
    const groupButton = Array.from(shadow.querySelectorAll('.engine[data-group-id]')).find((button) => button.dataset.groupId === expandedGroupId)
      // 分组本身可能藏在「更多」菜单里：那一项随菜单一起收掉后，直排区没有它的按钮。
      // 与常驻栏同一处理——挂到「更多」按钮旁边，而不是把刚打开的飞层又立刻藏掉。
      || engineList.querySelector('.more-engine');
    if (!groupButton) { groupEngineList.hidden = true; return; }
    const buttonRect = groupButton.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const flyoutWidth = Math.min(groupEngineList.offsetWidth || 160, window.innerWidth - 20);
    const flyoutHeight = Math.min(groupEngineList.offsetHeight || 36, window.innerHeight - 20);
    let left = buttonRect.right + 6;
    if (left + flyoutWidth > window.innerWidth - 10) left = buttonRect.left - flyoutWidth - 6;
    left = Math.max(10, Math.min(window.innerWidth - flyoutWidth - 10, left));
    const top = Math.max(10, Math.min(window.innerHeight - flyoutHeight - 10, buttonRect.top));
    groupEngineList.style.left = `${left - panelRect.left}px`;
    groupEngineList.style.top = `${top - panelRect.top}px`;
  }

  /**
   * 「更多」展开的菜单定位。
   *
   * 摆法与常驻搜索栏的更多飞层一致：紧贴触发按钮右缘、与按钮同高；右侧放不下
   * 就翻到左侧，两侧都放不下再夹回视口内。这样两处点开「更多」得到的是同一种
   * 「从按钮旁边长出来的一张菜单」。
   *
   * 为什么用 absolute 而不是常驻栏那样的 fixed：选区面板自身是 position:fixed，
   * 还带 transform / backdrop-filter，fixed 子节点会被它收成包含块，坐标系与视口
   * 不一致。分组飞层一直用「视口坐标 - 面板坐标」换算，这里沿用同一条路径。
   */
  function positionHiddenEngineList() {
    if (!expanded || hiddenEngineList.hidden) return;
    const moreButton = engineList.querySelector('.more-engine');
    if (!moreButton) { hiddenEngineList.hidden = true; return; }
    const buttonRect = moreButton.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const flyoutWidth = Math.min(hiddenEngineList.offsetWidth || 170, window.innerWidth - 20);
    const flyoutHeight = Math.min(hiddenEngineList.offsetHeight || 36, window.innerHeight - 20);
    let left = buttonRect.right + 6;
    if (left + flyoutWidth > window.innerWidth - 10) left = buttonRect.left - flyoutWidth - 6;
    left = Math.max(10, Math.min(window.innerWidth - flyoutWidth - 10, left));
    const top = Math.max(10, Math.min(window.innerHeight - flyoutHeight - 10, buttonRect.top));
    hiddenEngineList.style.left = `${left - panelRect.left}px`;
    hiddenEngineList.style.top = `${top - panelRect.top}px`;
  }

  function renderEngines() {
    engineList.replaceChildren();
    hiddenEngineList.replaceChildren();
    groupEngineList.replaceChildren();
    const available = getAvailableEngines();
    // 与常驻栏共用同一份图标节点缓存（见 fillIconMark）：浮层在切换分组时也会整批重建，
    // 图标同样不该重新解码、闪白。used 只管本次渲染的占用，两处各自一份。
    const usedIcons = new Set<HTMLImageElement>();
    const createEngineButton = (engine, target, allowIconOnly = true) => {
      const button = document.createElement('button');
      button.type = 'button';
      const iconOnly = allowIconOnly && (engine.iconOnly === true || settings.iconOnly[engine.id] === true);
      button.className = `engine ${engine.className}${iconOnly ? ' icon-only' : ''}`;
      button.dataset.engine = engine.id;
      const displayName = engine.isGroup ? groupLabel({ id: engine.groupId, name: engine.name }) : engine.isSpecial ? actionLabel(engine) : sourceLabel(engine);
      button.title = engine.isGroup ? t('展开{n}', { n: displayName }) : engine.isSpecial ? actionTooltip(engine) : t('使用{n}搜索', { n: displayName });
      const name = document.createElement('span');
      name.className = 'engine-name';
      name.textContent = displayName;
      if (engine.isGroup) {
        button.dataset.groupId = engine.groupId;
        button.setAttribute('aria-expanded', String(expandedGroupId === engine.groupId));
        // 直排区里的分组是纯文字按钮（浮层既有样式）；但「更多」菜单要和常驻栏的
        // 同一张菜单对齐，那里分组是「组」角标 + 名字的一行，所以补一枚角标。
        if (target === hiddenEngineList) {
          const mark = document.createElement('span');
          mark.className = 'engine-mark';
          mark.setAttribute('aria-hidden', 'true');
          fillIconMark(mark, engine, usedIcons);
          button.append(mark);
        } else {
          button.classList.add('group-text-only');
        }
      } else {
        const mark = document.createElement('span');
        mark.className = 'engine-mark';
        mark.setAttribute('aria-hidden', 'true');
        fillIconMark(mark, engine, usedIcons);
        button.append(mark);
      }
      button.append(name);
      button.addEventListener('click', () => {
        if (engine.isGroup) {
          // 与常驻栏一致：点分组就收掉「更多」菜单，换成该分组的飞层，
          // 不在同一块地方叠两张卡。
          expanded = false;
          expandedGroupId = expandedGroupId === engine.groupId ? null : engine.groupId;
          renderEngines();
          positionGroupEngineList();
          return;
        }
        if (!selectedText) return;
        if (engine.isSpecial) {
          if (engine.action === 'copy') void copyTextToClipboard(selectedText);
          else if (engine.action === 'notes') saveTextToOutlineNotes(selectedText);
          else if (engine.action === 'ask-ai') askAiFromAction(selectedText);
          hideAll();
          return;
        }
        const url = getSearchUrl(engine, selectedText);
        rememberSearch(selectedText);
        window.open(url, '_blank', 'noopener,noreferrer');
        hideAll();
      });
      // 右键：按次挑「本标签打开 / 新建标签打开」。分组与特殊功能不是搜索，保持浏览器原生菜单。
      button.addEventListener('contextmenu', (event) => {
        if (engine.isGroup || engine.isSpecial || !selectedText) return;
        event.preventDefault();
        event.stopPropagation();
        const text = selectedText;
        const url = getSearchUrl(engine, text);
        showOpenModeMenu(button.getRootNode(), { x: event.clientX, y: event.clientY }, [
          { label: t('本标签打开'), run: () => { rememberSearch(text); window.location.assign(url); hideAll(); } },
          { label: t('新建标签打开'), run: () => { rememberSearch(text); window.open(url, '_blank', 'noopener,noreferrer'); hideAll(); } }
        ]);
      });
      target.append(button);
    };
    const visibleCount = settings.defaultGroupCount || DEFAULT_SETTINGS.defaultGroupCount;
    const initial = available.slice(0, visibleCount);
    const hidden = available.slice(visibleCount);
    initial.forEach((engine) => createEngineButton(engine, engineList));
    if (expanded) hidden.forEach((engine) => createEngineButton(engine, hiddenEngineList, false));
    if (expandedGroupId) getGroupSources(expandedGroupId).forEach((engine) => createEngineButton(engine, groupEngineList, false));
    groupEngineList.hidden = !expandedGroupId || !groupEngineList.childElementCount;
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'engine more-engine';
    moreButton.title = expanded ? t('收起更多搜索源') : t('展开更多搜索源');
    moreButton.setAttribute('aria-label', moreButton.title);
    moreButton.innerHTML = expanded
      ? '<span class="engine-mark" aria-hidden="true">⌃</span>'
      : '<span class="engine-mark" aria-hidden="true">•••</span>';
    moreButton.addEventListener('click', () => {
      expanded = !expanded;
      expandedGroupId = null;
      // 菜单是浮在面板外的一张卡，不改变面板高度，所以不用重新定位面板；
      // renderEngines 末尾会按新状态把菜单位置摆好。
      renderEngines();
    });
    if (hidden.length) engineList.append(moreButton);
    hiddenEngineList.hidden = !expanded || !hidden.length;
    positionHiddenEngineList();
  }

  /**
   * 读出当前页面上的选区。
   *
   * 优先级：输入框 / 文本域 → 页面的 contenteditable → 文档选区 → 页面影子根里的选区。
   * 只读状态、不改 UI：展示（showForSelection）与「选区还在不在」的巡检
   * （selectionLooksGone）共用同一套判据，两处各写一份迟早会走样。
   */
  function readLiveSelection(): any {
    const inputSelection = getInputSelection();
    const contentEditableSelection = inputSelection ? null : getContentEditableSelection();
    const editableSelection: any = inputSelection || contentEditableSelection;
    if (editableSelection && settings.editableTriggerMode === 'none') return null;
    const selection = inputSelection ? null : window.getSelection();
    // 页面自己被 shadow DOM 包住的选区：document 选区会退化成 collapsed（见 getShadowSelection）。
    // 只在「折叠但 toString 仍有文字」时才去遍历影子根——普通点击的 toString 为空，
    // 不会为此付出遍历成本。主文档选区不受影响。
    const shadowSelection = inputSelection || contentEditableSelection
      ? null
      : (selection && selection.isCollapsed && selection.toString().trim() ? getShadowSelection() : null);
    if (!inputSelection && !shadowSelection && (!selection || selection.isCollapsed)) return null;
    // 浮层面板的搜索框是 textarea，能显示换行——选中的多段文字按原始分行进入，
    // 不再压成一行。单行的下游（常驻栏 input、弹窗 input、搜索 URL）各自折叠空白。
    const documentText = selection ? normalizeSelectionText(selection.toString(), true) : '';
    const text = editableSelection ? editableSelection.text
      : shadowSelection ? shadowSelection.text
      : documentText;
    // 这里**不设长度上限**：此前有一段 `text.length > 5000 → hideAll()`，于是整页
    // Ctrl+A（长文页动辄上万字）时触发点静默消失，用户看到的就是「有些地方选不中」。
    // 任何阈值都只是把同一个缺陷挪到另一个长度上，所以直接取消。
    if (!text) return null;
    const liveRange = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    const range = inputSelection ? null : contentEditableSelection?.range || shadowSelection?.range || liveRange;
    const rect = inputSelection ? inputSelection.rect
      : contentEditableSelection?.rect || shadowSelection?.rect || (liveRange ? getSelectionRect(liveRange) : null);
    // 归属元素只用于「这段文字有没有真的画在屏幕上」的判定。
    const element = inputSelection ? inputSelection.input : rangeOwnerElement(range) || editableSelection?.element || null;
    return { text, rect, range, element, inputSelection, editableSelection };
  }

  function showForSelection() {
    // Selection changes fire continuously while the user is dragging. Wait for mouseup.
    if (mouseButtonDown) return hideAll();
    if (contextAnchor) return;
    const live = readLiveSelection();
    // 有选区 ≠ 用户看得见选区：离屏元素上的「复制用选区」、滚出视口的段落、被隐藏的文字
    // 都会走到这里。这类选区不显示触发点（判据见 rectIsVisibleOnScreen）。
    if (!live || !liveSelectionIsOnScreen(live)) return hideAll();
    const { text, rect, range }: any = live;
    if (!selectionPointerPending && selectionPointerText && selectionPointerText !== text) selectionPointer = null;
    selectionPointerPending = false;
    selectionPointerText = text;
    selectedText = text;
    selectedRange = range ? range.cloneRange() : null;
    selectedInput = live.editableSelection?.input || live.editableSelection?.element || null;
    selectedInputStart = live.inputSelection ? selectedInput.selectionStart : 0;
    selectedInputEnd = live.inputSelection ? selectedInput.selectionEnd : 0;
    anchorRect = rect;
    contextAnchor = null;
    panelManuallyMoved = false;
    trigger.classList.toggle('disabled', !settings.enabled);
    queryInput.value = text;
    syncQueryRowExpandForText(text);
    resizeQueryInput();
    positionTrigger(rect);
    trigger.classList.add('visible');
    if (!panelOpen) panel.classList.remove('visible');
    // 选区可能在**没有任何用户操作**的情况下失效：选中的节点被页面删掉、消息被重渲染、
    // 祖先元素被 display:none —— Chromium 在这几种情况下不一定派发 selectionchange
    // （实测：节点删除后 selection 已 collapsed，事件没有来），图标就会留在原地。
    // 所以显示期间挂一支巡检，见 selectionLooksGone。
    startSelectionWatch();
    // 选中文字后触发点就要能点，所以在这里就提升宿主，而不是等面板打开。
    promoteToTopLayer(host);
  }

  /**
   * 触发点显示期间，「选区是不是已经没了」的巡检。
   *
   * 为什么必须轮询：选区失效未必伴随事件。页面把选中的节点整段删掉、把消息重渲染成新节点、
   * 给祖先加 display:none，选区都会静默消失或退化成空，而 Chromium 在这几种情况下不一定
   * 派发 selectionchange。用户看到的就是「明明没选中任何文字，图标却挂在那儿」。
   *
   * 成本口径：只在图标可见时跑（hideAll 立刻停），每 250ms 只比较文本、不读几何——
   * 几何（滚动、缩放、被滚出视口）走 scroll / resize 那条路，那里本来就要读布局。
   * 超长选区（整页 Ctrl+A）不做逐字比较：toString() 的复制成本随文档规模上涨，而这个
   * 量级的选区最常见的失效形态（节点被删）已经在 collapsed 上体现出来了。
   */
  function selectionLooksGone() {
    if (!selectedText || mouseButtonDown || panelOpen || contextAnchor) return false;
    if (selectedInput && !selectedInput.isConnected) return true;
    // 输入框 / 文本域的选区只有它自己有；元素失焦后浏览器不再画高亮，也就等于没有选区。
    // 焦点在扩展自己的浮层里不算失焦：用户点开面板时输入框本来就会让出焦点，
    // 关掉面板后图标还得留在原地等他再点。
    if (selectedInput && typeof selectedInput.selectionStart === 'number') {
      if (document.activeElement !== selectedInput && !host.contains(document.activeElement)) return true;
      return selectedInput.selectionStart === selectedInput.selectionEnd;
    }
    // contenteditable 与文档选区的判据一致（它们的选区都体现在 window.getSelection() 上）。
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return true;
    if (!selection.isCollapsed) {
      if (selectedText.length > 5000) return false;
      const text = normalizeSelectionText(selection.toString(), true);
      return !text || text !== selectedText;
    }
    // document 选区退化成 collapsed 但 toString 仍有文字：页面影子根里还留着选区。
    // 这里不判它（判它要遍历影子根，这份代价不该压在计时器上），交给 scroll / resize。
    return !selection.toString().trim();
  }

  function startSelectionWatch() {
    if (selectionWatchTimer) return;
    selectionWatchTimer = window.setInterval(() => {
      if (selectionLooksGone()) hideAll();
    }, 250);
  }

  function scheduleSelectionDisplay() {
    if (selectionShowTimer) window.clearTimeout(selectionShowTimer);
    const delay = Math.max(0, Math.min(2000, Number(settings.selectionTriggerDelay) || 0));
    selectionShowTimer = window.setTimeout(() => {
      selectionShowTimer = null;
      requestAnimationFrame(showForSelection);
    }, delay);
  }

  function openPanel() {
    cancelTriggerHoverOpen();
    if (!selectedText || !settings.enabled) return;
    panelOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
    queryInput.value = selectedText;
    syncQueryRowExpandForText(selectedText);
    resizeQueryInput();
    renderEngines();
    positionPanel();
    positionHiddenEngineList();
    panel.classList.add('visible');
    requestAnimationFrame(() => {
      queryInput.focus({ preventScroll: true });
      placeCaretAtEnd(queryInput);
      restoreSelectedRange();
    });
  }

  function getSelectionTriggerMode() {
    return selectedInput ? settings.editableTriggerMode : settings.triggerMode;
  }

  // 面板打开时只把焦点交给搜索框，不再整段选中：整段选中会让下一次输入直接覆盖原有内容，
  // 而用户往往只是想接着改。把光标落到末尾，与浏览器聚焦时的默认落点保持一致。
  function placeCaretAtEnd(input) {
    if (!input || typeof input.setSelectionRange !== 'function') return;
    const end = String(input.value || '').length;
    try { input.setSelectionRange(end, end); } catch { /* input may be detached */ }
  }

  function restoreSelectedRange() {
    if (selectedInput?.isConnected && typeof selectedInput.setSelectionRange === 'function') {
      try { selectedInput.setSelectionRange(selectedInputStart, selectedInputEnd); } catch { /* input may have changed */ }
    }
    if (!selectedRange || !selectedRange.startContainer?.isConnected) return;
    const selection = window.getSelection();
    if (!selection) return;
    // 页面 shadow DOM 里的选区不能交给 document 选区还原：它的容器不在文档树里，
    // addRange/selectNode 会抛错（而那只影响「面板打开后维持高亮」，不值得让流程中断）。
    if (selectedRange.startContainer.getRootNode?.() !== document) return;
    // 浏览器允许用 selectNodeContents 选中节点内容；某些选区的边界是元素本身时
    // addRange 会拒绝，这里按是否可接受分流。
    try {
      selection.removeAllRanges();
      selection.addRange(selectedRange.cloneRange());
    } catch { /* 还原高亮失败不影响搜索本身 */ }
  }

  function snapshotRect(rect) {
    if (!rect) return null;
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function contextLink(target) {
    return target instanceof Element ? target.closest('a[href]') : null;
  }

  function getContextLinkText(link) {
    if (!link) return '';
    return String(link.getAttribute('title') || link.getAttribute('aria-label') || link.textContent || link.href || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  function openContextSearch(message) {
    if (!settings.enabled) return;
    if (selectionShowTimer) { window.clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    const state = contextMenuState;
    const text = state?.isLink ? state.linkText || message.linkUrl || '' : message.selectionText || state?.selectionText || '';
    const rect = state?.rect || null;
    if (!text && !rect && !state) return;
    selectedText = text;
    selectedRange = state?.range?.cloneRange?.() || null;
    selectedInput = null;
    anchorRect = rect || { left: state?.x ?? 10, right: state?.x ?? 10, top: state?.y ?? 10, bottom: state?.y ?? 10, width: 0, height: 0 };
    contextAnchor = rect || { left: anchorRect.left, right: anchorRect.right, top: anchorRect.top, bottom: anchorRect.bottom, width: 0, height: 0 };
    selectionPointer = null;
    selectionPointerText = '';
    panelManuallyMoved = false;
    trigger.classList.remove('visible');
    trigger.setAttribute('aria-expanded', 'false');
    panelOpen = true;
    queryInput.value = text;
    syncQueryRowExpandForText(text);
    resizeQueryInput();
    renderEngines();
    panel.classList.add('visible');
    requestAnimationFrame(() => { positionPanel(); positionHiddenEngineList(); queryInput.focus({ preventScroll: true }); placeCaretAtEnd(queryInput); restoreSelectedRange(); });
    contextMenuState = null;
  }

  trigger.addEventListener('pointerdown', (event) => event.preventDefault());
  panelDragHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    panelDragHandle.setPointerCapture(event.pointerId);
    const rect = panel.getBoundingClientRect();
    panelDragState = { pointerId: event.pointerId, offsetX: startX - rect.left, offsetY: startY - rect.top, frame: 0, latestX: startX, latestY: startY };
    panel.classList.add('dragging');
  });
  panelDragHandle.addEventListener('pointermove', (event) => {
    if (!panelDragState || panelDragState.pointerId !== event.pointerId) return;
    panelDragState.latestX = event.clientX;
    panelDragState.latestY = event.clientY;
    if (panelDragState.frame) return;
    panelDragState.frame = requestAnimationFrame(() => {
      panelDragState.frame = 0;
      if (!panelDragState) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.max(10, Math.min(window.innerWidth - width - 10, panelDragState.latestX - panelDragState.offsetX));
      const top = Math.max(10, Math.min(window.innerHeight - height - 10, panelDragState.latestY - panelDragState.offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panelManuallyMoved = true;
      positionGroupEngineList();
      positionHiddenEngineList();
    });
  });
  function finishPanelDrag(event) {
    if (event && panelDragState && panelDragState.pointerId === event.pointerId && panelDragHandle.hasPointerCapture(event.pointerId)) panelDragHandle.releasePointerCapture(event.pointerId);
    if (panelDragState?.frame) cancelAnimationFrame(panelDragState.frame);
    panelDragState = null;
    panel.classList.remove('dragging');
  }
  panelDragHandle.addEventListener('pointerup', finishPanelDrag);
  panelDragHandle.addEventListener('pointercancel', finishPanelDrag);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (panelOpen || trigger.classList.contains('visible')) {
      event.preventDefault();
      hideAll();
    }
  }, true);
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // 这些消息按标签页广播。内容脚本现在只注入顶层文档，能收到它们的一定是用户
      // 正在看的那个页面实例——选区、笔记侧栏与对话层都只有这一份。
      if (message?.type === 'get-selection') {
        // 弹窗的搜索框是单行 input，显示不了换行，这里按单行规整。
        sendResponse({ text: getInputSelection()?.text || normalizeSelectionText(window.getSelection()?.toString(), false) || '' });
        return;
      }
      // 弹窗里的「笔记」按钮把内容交给页面侧栏写入：笔记的最新状态在它手上。
      if (message?.type === 'save-note') {
        sendResponse({ ok: saveTextToOutlineNotes(message.text) });
        return;
      }
      // 弹窗里的「问 ai」按钮把问题交给页面侧的对话层：对话实现只有页面这一份。
      if (message?.type === 'ask-ai') {
        sendResponse({ ok: askAiFromAction(message.text) });
        return;
      }
      if (message?.type === 'open-context-search') openContextSearch(message);
    });
  }
  function cancelTriggerHoverOpen() {
    if (!triggerHoverTimer) return;
    window.clearTimeout(triggerHoverTimer);
    triggerHoverTimer = null;
  }
  function scheduleTriggerHoverOpen() {
    cancelTriggerHoverOpen();
    if (!settings.enabled || getSelectionTriggerMode() !== 'hover' || panelOpen) return;
    triggerHoverTimer = window.setTimeout(() => {
      triggerHoverTimer = null;
      if (settings.enabled && getSelectionTriggerMode() === 'hover' && trigger.matches(':hover')) openPanel();
    }, TRIGGER_HOVER_OPEN_DELAY);
  }
  trigger.addEventListener('pointerenter', (event) => {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) selectionPointer = { x: event.clientX, y: event.clientY };
    scheduleTriggerHoverOpen();
  });
  trigger.addEventListener('pointerleave', cancelTriggerHoverOpen);
  trigger.addEventListener('click', (event) => {
    if (!settings.enabled) return;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) selectionPointer = { x: event.clientX, y: event.clientY };
    const triggerMode = getSelectionTriggerMode();
    if (triggerMode === 'none') return hideAll();
    if (triggerMode === 'hover') { cancelTriggerHoverOpen(); return openPanel(); }
    panelOpen = !panelOpen;
    trigger.setAttribute('aria-expanded', String(panelOpen));
    if (panelOpen) return openPanel();
    panel.classList.toggle('visible', panelOpen);
  });
  queryInput.addEventListener('input', () => { selectedText = queryInput.value;
  resizeQueryInput(); if (panelOpen && anchorRect) requestAnimationFrame(() => { positionPanel(); positionGroupEngineList(); positionHiddenEngineList(); }); });
  queryExpand.addEventListener('click', () => {
    setQueryRowExpanded(!queryRow.classList.contains('expanded'));
    resizeQueryInput();
    queryInput.focus();
    if (panelOpen && anchorRect) requestAnimationFrame(() => {
      positionPanel(anchorRect, { left: parseFloat(trigger.style.left) || 0 });
      positionGroupEngineList();
      positionHiddenEngineList();
    });
  });
  document.addEventListener('input', (event) => {
    const site = getPinnedSite();
    if (!site || !pinnedHost) return;
    if (site.selectorConfigured !== false && event.target === findVisibleInput(site.selector)) syncPinnedQuery(site);
  }, true);
  document.addEventListener('mouseup', (event) => {
    mouseButtonDown = false;
    if (eventInsideOverlay(event)) return;
    selectionPointer = { x: event.clientX, y: event.clientY };
    selectionPointerPending = true;
    applySelectionToPinnedQuery();
    scheduleSelectionDisplay();
  }, true);
  document.addEventListener('touchend', (event) => {
    if (eventInsideOverlay(event)) return;
    const point = event.changedTouches?.[0];
    selectionPointer = point ? { x: point.clientX, y: point.clientY } : null;
    selectionPointerPending = Boolean(point);
    applySelectionToPinnedQuery();
    scheduleSelectionDisplay();
  }, true);
  let contextMenuState = null;
  document.addEventListener('contextmenu', (event) => {
    if (eventInsideOverlay(event)) return;
    const link = contextLink(event.target);
    const selection = window.getSelection();
    const selectionText = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, ' ').trim() : '';
    const range = !link && selection && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null;
    const rect = link ? snapshotRect(link.getBoundingClientRect()) : range ? snapshotRect(getSelectionRect(range)) : null;
    contextMenuState = { x: event.clientX, y: event.clientY, linkText: getContextLinkText(link), isLink: Boolean(link), selectionText, rect, range };
  }, true);
  document.addEventListener('selectionchange', () => {
    if (shadow.activeElement) return;
    if (panelOpen) return;
    if (mouseButtonDown) return;
    scheduleSelectionDisplay();
  });
  // 键盘选区（Shift+方向键、Ctrl/⌘+A）不经过 mouseup，单独接一条；鼠标拖选期间
  // selectionchange 会连续触发，所以用 mouseButtonDown 挡掉，等 mouseup 再处理。
  document.addEventListener('selectionchange', () => {
    if (mouseButtonDown) return;
    applySelectionToPinnedQuery();
  });
  document.addEventListener('mousedown', (event) => {
    mouseButtonDown = true;
    // 「打开方式」菜单在常驻栏的 shadow root 里，不算 eventInsideOverlay：
    // 若不排除它，按在菜单上的那一下会先 hideAll() 把菜单本身拆掉，click 永远到不了。
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const pressInOpenMenu = Boolean(openModeMenu && path.includes(openModeMenu.element));
    if (!eventInsideOverlay(event) && !pressInOpenMenu) hideAll();
  }, true);
  window.addEventListener('blur', () => { mouseButtonDown = false; });
  window.addEventListener('resize', () => {
    // 视口宽度变了：常驻栏的横向位置、宿主的测量宽度都要重算。
    pinnedBarHostWidthDirty = true;
    scheduleRefreshSelectionPosition(false);
  });
  /**
   * 把「重算浮层/常驻栏位置」压到每帧一次。
   *
   * 为什么：滚动事件在一帧里就可能派发多次，而 window 上的 scroll 监听与 document 上的
   * 捕获监听各会收到一次——一次滚动最多让 positionPinnedBar 跑两遍，每遍都要读一次布局
   * 再写一次定位。位置只需要在「这一帧画之前」是新的，所以按帧合并：语义等价，次数减半以上。
   * resize 走同一条路：连续拉伸窗口时同样只需要一帧一次。
   */
  function scheduleRefreshSelectionPosition(preserveHorizontal = true) {
    if (refreshSelectionFrame) return;
    refreshSelectionFrame = window.requestAnimationFrame(() => {
      refreshSelectionFrame = 0;
      refreshSelectionPosition(preserveHorizontal);
    });
  }
  function refreshSelectionPosition(preserveHorizontal = true) {
    positionPinnedBar(getPinnedSite());
    if (anchorRect && selectedText) {
      let rect = null;
      if (selectedRange && selectedRange.startContainer?.isConnected) {
        rect = getSelectionRect(selectedRange);
      } else if (selectedInput && selectedInput.isConnected && typeof selectedInput.selectionStart === 'number') {
        rect = getInputSelectionRect(selectedInput, selectedInputStart, selectedInputEnd);
      } else {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) rect = getSelectionRect(selection.getRangeAt(0));
      }
      if (rect) {
        // 选区滚出视口、祖先被隐藏、节点被删：触发点不该被 positionTrigger 夹在屏幕边缘
        // 继续挂着——那同样是「没选中任何文字却有个图标」。面板开着时不收：用户正在里面输入，
        // 页面随滚动变化不该打断他。
        if (!panelOpen && !rangeHasVisibleRect(selectedRange) && !rectIsVisibleOnScreen(rect)) {
          hideAll();
          return;
        }
        if (preserveHorizontal && anchorRect) rect = { ...rect, left: anchorRect.left, right: anchorRect.right, width: anchorRect.width };
        anchorRect = rect;
        if (contextAnchor && selectedRange) contextAnchor = { ...contextAnchor, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        // Once the page moves, anchor the panel to the live selection instead of
        // the original mouse-up point, which is no longer in the same viewport spot.
        selectionPointer = null;
        const triggerPosition = positionTrigger(anchorRect);
        if (panelOpen) { positionPanel(anchorRect, triggerPosition); positionGroupEngineList(); positionHiddenEngineList(); }
        if (panelOpen) restoreSelectedRange();
      } else if (!panelOpen) {
        // 连几何都取不到：选区的容器已经不在文档里了（或整段被隐藏）。
        hideAll();
        return;
      }
    }
  }
  window.addEventListener('scroll', () => scheduleRefreshSelectionPosition(true), { passive: true });
  document.addEventListener('scroll', () => scheduleRefreshSelectionPosition(true), true);

  function tryPrefillDoubao() {
    if (!/doubao\.com$/i.test(location.hostname)) return;
    const raw = new URLSearchParams(location.search).get('quickfind');
    if (!raw) return;
    // 与常驻栏同一口径：地址里可能残留一层百分号编码，写进输入框前先还原。
    const query = decodeQueryText(raw);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      if (!input) { if (attempts > 30) window.clearInterval(timer); return; }
      if (input.matches('[contenteditable="true"]')) input.textContent = query;
      else { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor?.set) descriptor.set.call(input, query); else input.value = query; }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: query }));
      input.focus();
      if (attempts > 8) { window.clearInterval(timer); history.replaceState(null, '', `${location.pathname}${location.hash}`); }
    }, 400);
  }
  document.documentElement.append(host);
  // LLM 侧栏与对话层都挂在这个宿主里，必须先入文档再初始化。
  initializeLlmDock();
  loadSettings();
  const pinnedObserver = new MutationObserver(schedulePinnedMount);
  pinnedObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedulePinnedMount);
  schedulePinnedMount();
  tryPrefillDoubao();
  },
});
