import type { SearchSource } from './settings';

/**
 * 特殊功能按钮：搜索列表里不跳转搜索、直接做一件事的条目。
 *
 * 选项页的配置列表、页面侧栏与弹窗的搜索列表读的是同一份定义。此前三个入口各写一份，
 * 新增一个动作要同步改三处；漏掉的一处会把分组里的 `action:<id>` 当成无效条目丢掉，
 * 用户下次在那个入口拖动排序就会把这枚按钮从配置里抹掉。因此集中到这里。
 *
 * 新增动作时要同时确认两件事：
 *   1. 三个入口都接上执行逻辑——页面浮动面板、常驻搜索栏（content/index.ts）、弹窗（popup/main.ts）；
 *   2. 若动作要写笔记，存储侧的形状见 shared/notes.ts。
 */
export const SPECIAL_ACTIONS: SearchSource[] = [
  {
    id: 'copy',
    name: '复制',
    detail: '复制当前搜索内容',
    specialTitle: '复制搜索内容',
    mark: '复',
    className: 'special-copy',
    action: 'copy',
    isSpecial: true
  },
  {
    id: 'notes',
    name: '笔记',
    detail: '存到无限大纲笔记第一行',
    specialTitle: '把内容存到笔记第一行',
    mark: '记',
    className: 'special-notes',
    action: 'notes',
    isSpecial: true
  }
];
