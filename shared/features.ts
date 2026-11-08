/**
 * 已下线模块的开关。
 *
 * 这里只回答一个问题：**界面上还认不认这个模块**。模型层（`shared/outline.ts`、
 * `shared/notes.ts`、`shared/note-drag.ts`）与存储里的数据都不动，所以把开关改回 `true`
 * 就能原样恢复，不需要回滚代码，也不会碰到用户已经写下的笔记。
 *
 * 关闭后的实际表现：
 *   - `PAGE_SIDEBAR_ENABLED = false`：网页里不再生成右侧 dock 的滑杆与面板；
 *     「问 ai」的对话窗口仍照常弹出（它只是借用同一个宿主承载，本身不是侧栏）。
 *   - `OUTLINE_NOTES_ENABLED = false`：设置页不再有「无限大纲笔记」这一页，
 *     页面侧栏也不会再有该标签；特殊功能按钮「笔记」随之下线。
 */
export const PAGE_SIDEBAR_ENABLED = false;

export const OUTLINE_NOTES_ENABLED = false;