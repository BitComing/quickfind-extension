/**
 * 界面语言的唯一实现。
 *
 * 约定：源文案（简体中文）本身就是字典键，`t('已保存')` 在英文下返回 'Saved'。
 *
 * 为什么不用 `save.saved` 这类语义键：这个项目的界面文案一直是中文直写，改成语义键要
 * 同时改上百处调用点并维护两份命名，收益只是「键看起来更规范」。用源文案当键的好处是
 * 调用点读起来就是界面上的那句话，漏译时自动回落到中文而不是显示一个键名；代价是改了
 * 中文文案就要同步改字典键——这与「改文案就改一处」的直觉一致，反而不容易漂移。
 *
 * 用法：
 *   - 动态文本：`t('已选 {n} 项', { n: 3 })`；
 *   - 静态 HTML：给元素加 `data-i18n`（textContent）、`data-i18n-title`（title）、
 *     `data-i18n-aria-label`、`data-i18n-placeholder`，启动时与切换语言后各调一次
 *     `applyI18n(root)`；
 *   - 语言来自 sync 的 `language` 键，三个入口读取后都调用 `setLocale()`。
 */

export type Locale = 'zh-CN' | 'en';

let currentLocale: Locale = 'zh-CN';

/** 把存储里读到的任意值收敛成受支持的语言；不认识的一律回落中文。 */
export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function setLocale(value: unknown): Locale {
  currentLocale = normalizeLocale(value);
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** `Intl.*` 用的区域标签。目前两种语言各一个标签，单独收口免得散落。 */
export function localeTag(): string {
  return currentLocale;
}

/** 英文文案。键是中文源文案，值是英文；模板变量用 `{name}`。 */
const EN: Record<string, string> = {
  // ── 应用外壳 ───────────────────────────────────────────────────────
  'QuickFind 设置': 'QuickFind Settings',
  '设置导航': 'Settings navigation',
  '设置分类': 'Settings sections',
  '常用设置': 'General',
  '搜索源与分组': 'Sources & Groups',
  '历史记录': 'History',
  '无限大纲笔记': 'Infinite Outline Notes',
  '关于': 'About',

  // ── 常用设置 ───────────────────────────────────────────────────────
  '界面': 'Interface',
  '语言': 'Language',
  '界面语言': 'Interface language',
  '切换后立即生效，并同步到其他设备': 'Applies immediately and syncs to your other devices',
  '选中文字': 'Text selection',
  '触发方式': 'Trigger',
  '网页中选中文字的触发方式': 'How the search button opens after selecting text',
  '点击': 'Click',
  '悬停': 'Hover',
  '点击搜索按钮展开搜索列表': 'Click the search button to open the list',
  '鼠标移入按钮即展开搜索列表': 'Hovering the button opens the list',
  '默认分组展示数量': 'Items shown in the default group',
  '其余项目收起到「更多」菜单': 'The rest collapse into the “More” menu',
  '项': 'items',
  '图标显示延时': 'Icon delay',
  '松开鼠标后延迟多久显示搜索图标': 'Delay before the search icon appears after releasing the mouse',
  '毫秒': 'ms',
  '编辑框图标': 'Icon in text fields',
  '输入框、文本域与可编辑区域中的选中文字': 'Selections inside inputs, text areas and editable regions',
  '编辑框中选中文字的图标': 'Icon for selections inside text fields',
  '点击图标后展开搜索列表': 'Click the icon to open the list',
  '鼠标移入图标即展开搜索列表': 'Hovering the icon opens the list',
  '编辑框选区不显示图标': 'Do not show an icon for text-field selections',
  '不显示': 'Off',
  '常驻搜索栏': 'Pinned search bar',
  '已启用': 'Enabled',
  '常驻栏在这些站点出现': 'The pinned bar appears on these sites',
  '管理': 'Manage',
  '指针离开常驻栏后多久自动收起': 'Delay before the pinned bar collapses after the pointer leaves',
  '鼠标离开后收起延时': 'Collapse delay',
  '没有匹配站点搜索框时，使用最近一次搜索内容': 'When a site has no matching search box, use the most recent query',
  '所有站点都显示': 'Show on all sites',
  '所有站点都显示常驻搜索栏': 'Show the pinned search bar on all sites',

  // ── 搜索源与分组 ───────────────────────────────────────────────────
  '特殊功能按钮': 'Special buttons',
  '搜索源分组': 'Source groups',
  '批量移动到分组': 'Move to group',
  '已选 0 项': '0 selected',
  '已选 {n} 项': '{n} selected',
  '移动到分组': 'Move to group',
  '删除所选搜索源': 'Delete selected sources',
  '添加自定义搜索源': 'Add a custom source',
  '添加搜索源': 'Add source',
  '新建分组': 'New group',
  '搜索源': 'Sources',
  '仅图标 · 启用': 'Icon only · Enabled',
  '个搜索源': 'sources',
  '{n} 项': '{n} items',
  '这个分组还没有搜索源': 'No sources in this group yet',
  '仅显示图标': 'Icon only',
  '启用搜索源': 'Enable source',
  '启用按钮': 'Enable button',
  '重命名按钮': 'Rename button',
  '从分组移除': 'Remove from group',
  '编辑搜索源': 'Edit source',
  '删除搜索源': 'Delete source',
  '拖动排序，或拖到分组标签中移动': 'Drag to reorder, or drop on a group tab to move',
  '拖动调整位置，或拖到分组标签中移动': 'Drag to reorder, or drop on a group tab to move',
  '拖动排序': 'Drag to reorder',
  '选择搜索源': 'Select source',
  '选择{n}按钮': 'Select {n} button',
  '{n}启用': 'Enable {n}',
  '{n}仅显示图标': 'Show only the icon for {n}',
  '{n}在搜索列表中显示': 'Show {n} in the search list',
  '在搜索列表中显示': 'Show in the search list',
  '默认组，可拖入搜索源或特殊功能按钮': 'Default group — drop sources or special buttons here',
  '打开{n}，可将搜索源或特殊功能按钮拖到此处，也可拖动标签调整分组顺序': 'Open {n}; drop sources or special buttons here, or drag the tab to reorder groups',
  '打开{n}': 'Open {n}',
  '返回{n}': 'Back to {n}',
  '重命名分组': 'Rename group',
  '删除分组': 'Delete group',
  '分组名称': 'Group name',
  '新分组': 'New group',
  '按钮名称': 'Button name',
  '未命名分组': 'Untitled group',
  '默认组': 'Default group',
  '视频': 'Video',
  '{n} 个站点': '{n} sites',
  '未选择': 'None selected',
  '编辑站点': 'Edit site',
  '删除站点': 'Delete site',
  '编辑{n}站点': 'Edit {n} site',
  '删除{n}站点': 'Delete {n} site',
  '搜索源：{n}': 'Source: {n}',
  ' · 搜索源': ' · source',
  '分组': 'Group',
  '组': 'G',
  '群': 'G',

  // ── 自定义源 / 站点弹窗 ────────────────────────────────────────────
  '名称': 'Name',
  '图标': 'Icon',
  'URL 模板': 'URL template',
  '取消': 'Cancel',
  '添加': 'Add',
  '保存': 'Save',
  '关闭': 'Close',
  'URL 中需要包含 {query} 占位符。': 'The URL must contain a {query} placeholder.',
  '请输入有效的 http 或 https 搜索 URL。': 'Enter a valid http or https search URL.',
  '免费版最多启用 {n} 个搜索源，先关掉一个再新增；激活会员后不限数量。': 'The free plan allows {n} sources. Turn one off first, or activate a membership for unlimited sources.',
  '添加常驻站点': 'Add pinned site',
  '编辑常驻站点': 'Edit pinned site',
  '管理常驻站点': 'Manage pinned sites',
  '站点名称': 'Site name',
  '搜索框 CSS 选择器': 'Search box CSS selector',
  '请至少填写站点 URL。': 'Enter at least the site URL.',
  'CSS 选择器格式无效。': 'Invalid CSS selector.',
  '关闭常驻站点管理': 'Close pinned site management',

  // ── 图标编辑 ───────────────────────────────────────────────────────
  '搜索源图标': 'Source icon',
  '关闭图标面板': 'Close icon panel',
  '默认图标': 'Default icon',
  '用这个站点自己的网站图标': 'Use the site’s own favicon',
  '获取网站图标': 'Get site icon',
  '从本机选一张图片': 'Pick an image from this device',
  '上传图片': 'Upload image',
  '恢复默认': 'Restore default',
  '或粘贴一个图标链接': 'Or paste an icon link',
  '图标链接': 'Icon link',
  '使用链接': 'Use link',
  '更改图标': 'Change icon',
  '更改{n}的图标': 'Change the icon for {n}',
  '这个搜索源的地址里没有可用的网站域名。': 'This source URL has no usable site domain.',
  '请输入图标地址。': 'Enter an icon URL.',
  '图标地址需要使用 http 或 https。': 'The icon URL must use http or https.',
  '无法使用该图标地址。': 'That icon URL cannot be used.',
  '请选择图片。': 'Choose an image.',
  '图片不能超过 5 MB。': 'The image must be 5 MB or smaller.',
  '无法读取图片。': 'The image could not be read.',
  '无法使用该图片。': 'That image cannot be used.',
  '图片尺寸无效。': 'Invalid image dimensions.',
  '本地图片': 'Local image',
  '网站图标': 'Site icon',
  '自定义链接': 'Custom link',

  // ── 保存状态与失败原因 ─────────────────────────────────────────────
  '已保存': 'Saved',
  '保存中…': 'Saving…',
  '保存失败': 'Save failed',
  '保存失败：写入过于频繁，稍后再试。': 'Save failed: too many writes. Try again in a moment.',
  '保存失败：换成浏览器同步后超出单键容量上限（8 KB）。占位最大的是自定义图标，可改用图标地址或精简搜索源。': 'Save failed: the synced data exceeded the 8 KB per-item limit. Custom icons take the most space — use an icon URL or remove some sources.',
  '保存失败：{n}': 'Save failed: {n}',
  '浏览器未接受这次写入。': 'The browser rejected this write.',

  // ── 历史记录 ───────────────────────────────────────────────────────
  '暂无搜索历史': 'No search history yet',
  '选择历史记录': 'Select history entry',
  '选择历史记录：{n}': 'Select history entry: {n}',
  '复制历史记录': 'Copy history entry',
  '删除历史记录': 'Delete history entry',
  '全选历史记录': 'Select all history',
  '取消全选历史记录': 'Clear history selection',
  '删除所选历史记录': 'Delete selected history',
  '清空历史记录': 'Clear history',
  '清空': 'Clear',
  '已复制': 'Copied',
  '复制失败': 'Copy failed',

  // ── LLM 对话 ───────────────────────────────────────────────────────
  'LLM 对话': 'LLM Chat',
  '显示右侧「随心问」': 'Show “Quick Ask” on the right',
  '与「无限大纲笔记」同处右侧 dock，关闭后两者都不再出现': 'Shares the right-hand dock with outline notes; turning it off hides both',
  '显示右侧随心问面板': 'Show the Quick Ask panel on the right',
  '面板': 'Panel',
  '接口': 'API',
  'OpenAI 兼容的 Chat Completions 接口': 'An OpenAI-compatible Chat Completions endpoint',
  '启用': 'Enable',
  '启用 LLM 接口': 'Enable the LLM endpoint',
  'API 地址': 'API endpoint',
  '模型': 'Model',
  '系统提示词': 'System prompt',
  '请用简洁、准确的中文回答。': 'Answer concisely and accurately.',
  '回答由你配置的模型生成': 'Answers come from the model you configured',
  '随选随问的 AI 对话': 'Ask AI about anything you select',
  '无限层级的大纲笔记': 'Infinitely nested outline notes',
  '随心问': 'Quick Ask',
  '新建对话': 'New chat',
  '最近对话': 'Recent chats',
  '从一个问题开始': 'Start with a question',
  '你的对话会保存在这里，下一次打开可以继续。': 'Your chats are saved here so you can pick them up later.',
  '输入问题': 'Type a question',
  '问点什么…': 'Ask something…',
  'Enter 发送 · Shift+Enter 换行': 'Enter to send · Shift+Enter for a new line',
  '发送问题': 'Send question',
  '发送': 'Send',
  '收起': 'Collapse',
  '展开': 'Expand',
  '更多': 'More',
  '收起更多搜索源': 'Show fewer sources',
  '展开更多搜索源': 'Show more sources',
  '新对话': 'New chat',
  'LLM 助手': 'LLM assistant',
  '历史会话': 'Chat history',
  '查看历史会话': 'View chat history',
  '返回对话': 'Back to chat',
  '置顶窗口': 'Pin window',
  '关闭对话': 'Close chat',
  '回到底部': 'Back to bottom',
  '继续提问': 'Ask a follow-up',
  '继续追问…': 'Ask a follow-up…',
  '发送消息': 'Send message',
  '调整窗口大小': 'Resize window',
  '拖动调整大小': 'Drag to resize',
  '还没有历史对话。提一个问题，它会出现在这里。': 'No chats yet. Ask a question and it will show up here.',
  '未命名对话': 'Untitled chat',
  '等待 LLM 回复…': 'Waiting for the LLM…',
  '正在思考…': 'Thinking…',
  '请求未完成': 'Request incomplete',
  'LLM 已关闭': 'LLM is off',
  '待配置 API Key': 'API key not set',
  '{n} · 已配置': '{n} · configured',
  '{n} 条': '{n}',
  '{n} 次提问': '{n} questions',
  '删除这段对话': 'Delete this chat',
  '确认删除': 'Delete',
  '确认删除这段对话': 'Delete this chat?',
  '你': 'You',
  '正在生成回复': 'Generating a reply',
  '请求失败（{n}）': 'Request failed ({n})',
  '接口返回了空回复。': 'The API returned an empty reply.',
  '请求超时（超过 {n} 秒未响应）。': 'Request timed out (no response in {n} seconds).',
  '请先在设置页填写 API 地址和模型。': 'Fill in the API endpoint and model in Settings first.',
  '无法连接到扩展后台。': 'Could not reach the extension background.',
  '接口请求失败。': 'The API request failed.',
  '请求失败：{n}': 'Request failed: {n}',
  '无法连接到 API。': 'Could not reach the API.',
  '模型回复超过 {n} 秒仍未完成，已中止。': 'The model did not finish within {n} seconds and was stopped.',

  // ── 页面浮层 / 常驻栏 ──────────────────────────────────────────────
  '使用搜索引擎搜索选中文字': 'Search the selected text',
  '搜索选中文字': 'Search selected text',
  '搜索引擎列表': 'Search engine list',
  '长按拖动搜索列表': 'Press and drag to move the list',
  '编辑搜索内容': 'Edit search text',
  '展开多行输入': 'Expand to multiple lines',
  '收起多行输入': 'Collapse to one line',
  'QuickFind 常驻搜索列表': 'QuickFind pinned search list',
  '当前搜索文本': 'Current search text',
  '展开常驻搜索栏': 'Expand the pinned search bar',
  '搜索结果将在新标签页打开；点击改为当前页面打开': 'Results open in a new tab; click to open in this tab instead',
  '搜索结果将在当前页面打开；点击改为新标签页打开': 'Results open in this tab; click to open in a new tab instead',
  '本标签打开': 'Open in this tab',
  '新建标签打开': 'Open in a new tab',
  '使用': 'Search with',
  '搜索': 'Search',
  '搜索：{n}': 'Search with {n}',
  '本标签': 'This tab',
  '新标签': 'New tab',
  '收起 QuickFind 面板': 'Collapse the QuickFind panel',
  '展开 QuickFind 面板': 'Expand the QuickFind panel',
  '右侧 LLM 对话': 'LLM chat on the right',
  '展开 LLM 对话': 'Expand LLM chat',
  '收起 LLM 面板': 'Collapse the LLM panel',
  '面板功能': 'Panel tabs',
  'LLM 聊天历史': 'LLM chat history',
  '搜索笔记': 'Search notes',
  '撤销': 'Undo',
  '重做': 'Redo',
  '撤销（Ctrl/⌘+Z）': 'Undo (Ctrl/⌘+Z)',
  '重做（Ctrl/⌘+Shift+Z）': 'Redo (Ctrl/⌘+Shift+Z)',
  '新建项目': 'New item',
  '插入': 'Insert',
  '把页面上选中的文字加入笔记': 'Add the selected page text to notes',
  '返回根目录': 'Back to root',
  '返回上级': 'Go up',
  '根目录': 'Root',
  '展开全部': 'Expand all',
  '收起全部': 'Collapse all',
  '大纲笔记': 'Outline notes',
  '未命名项目': 'Untitled item',
  '正在加载笔记…': 'Loading notes…',
  '找到 {n} 项': '{n} found',
  '没有匹配的笔记': 'No matching notes',
  '还没有笔记项目': 'No notes yet',
  '还没有笔记项目，点击“新建”开始。': 'No notes yet. Click “New” to start.',
  '这个项目还没有子项目，按 Enter 新建。': 'No sub-items yet. Press Enter to add one.',
  '还没有子项目': 'No sub-items',
  '展开项目': 'Expand item',
  '收起项目': 'Collapse item',
  '没有子项目': 'No sub-items',
  '标记完成': 'Mark as done',
  '标记未完成': 'Mark as not done',
  '专注此项目': 'Focus on this item',
  '大纲项目': 'Outline item',
  '导入失败：请选择有效的 JSON 或 Markdown 大纲文件。': 'Import failed: choose a valid JSON or Markdown outline file.',

  // ── 特殊功能按钮的默认名与说明 ──────────────────────────────────────
  '复制': 'Copy',
  '复制当前搜索内容': 'Copy the current search text',
  '复制搜索内容': 'Copy search text',
  '笔记': 'Note',
  '存到无限大纲笔记第一行': 'Save to the first line of outline notes',
  '把内容存到笔记第一行': 'Save the text to the first line of notes',
  '问 ai': 'Ask AI',
  '在当前页面打开对话面板提问': 'Open the chat panel on this page',
  '向 AI 提问': 'Ask AI',

  // ── 弹窗 ───────────────────────────────────────────────────────────
  '在网页中打开 AI 对话': 'Open AI chat on the page',
  '搜索源设置': 'Source settings',
  '搜索内容': 'Search text',
  '输入要搜索的内容': 'Type something to search',
  '清空搜索框': 'Clear the search box',
  '搜索历史': 'Search history',
  '默认分组': 'Default group',
  '切换到{n}，拖动标签可调整分组顺序': 'Switch to {n}; drag tabs to reorder',
  '当前页面无法显示对话窗口，请在普通网页上使用。': 'The chat window cannot appear on this page. Use it on a normal web page.',

  // ── 会员 ───────────────────────────────────────────────────────────
  '版本': 'Version',
  '开发预览': 'Dev preview',
  '付费会员': 'Membership',
  '激活码': 'Activation code',
  '当前状态': 'Status',
  '当前': 'Current',
  '授权方式': 'Activation',
  '停用': 'Deactivate',
  '清除激活码': 'Clear activation code',
  '清除这台设备上的会员': 'Remove the membership from this device',
  '激活': 'Activate',
  '激活码一码对应一次激活，激活后随浏览器账号同步到其他设备': 'Each code activates once and then syncs with your browser account',
  '一码对应一次激活，激活后随浏览器账号同步到其他设备': 'One code, one activation; it then syncs with your browser account',
  '当前会员状态与到期时间': 'Current membership status and expiry',
  '邮箱': 'Email',
  '购买时填写的邮箱；激活码与该邮箱绑定，别人拿到码也用不了': 'The email you used at checkout. The code is bound to it, so a shared code will not work',
  '激活码与购买时填写的邮箱绑定，默认绑定 1 台设备': 'Bound to your checkout email and to 1 device by default',
  '激活码与购买时填写的邮箱绑定，最多可在 5 台设备上激活；在一台设备上「清除激活码」会退回一个名额': 'Bound to your checkout email, up to 5 devices; clearing it on a device frees that slot',
  '请填写购买时使用的邮箱。': 'Enter the email you used at checkout.',
  '激活中…': 'Activating…',
  '激活失败，请稍后再试。': 'Activation failed. Please try again later.',
  '激活码无效，请检查是否输入正确。': 'This activation code is not valid. Check what you typed.',
  '邮箱格式不正确。': 'That email address looks wrong.',
  '邮箱与激活码不匹配。激活码与购买时填写的邮箱绑定。': 'This email does not match the activation code. The code is bound to the email used at checkout.',
  '该激活码已绑定设备数达到上限。请先在原设备上「清除激活码」，或联系卖家解绑。': 'This code has reached its device limit. Clear it on the old device, or ask the seller to unbind it.',
  '该激活码已被停用，请联系卖家。': 'This activation code has been disabled. Contact the seller.',
  '该授权已到期。': 'This licence has expired.',
  '尝试次数过多，请稍后再试。': 'Too many attempts. Try again later.',
  '登录状态已失效，请重新输入激活码。': 'Your session has expired. Enter the activation code again.',
  '登录状态已过期，请重新输入激活码。': 'Your session has expired. Enter the activation code again.',
  '这台设备已被解绑，请重新激活。': 'This device was unbound. Activate again.',
  '无法连接激活服务器，请检查网络后重试。': 'Cannot reach the activation server. Check your connection and try again.',
  '用户自建的分组数量与免费上限；随扩展附带的预设分组不计入': 'Groups you created, against the free limit; preset groups are excluded',
  '已启用的搜索源数量与免费上限；关掉的源不占名额': 'Enabled sources, against the free limit; disabled sources do not count',
  '免费版': 'Free',
  '一年会员': 'Yearly',
  '永久会员': 'Lifetime',
  '0 元': '¥0',
  '5 元': '¥5',
  '10 元': '¥10',
  '/ 年': '/ year',
  '/ 永久': '/ lifetime',
  '搜索源分组不限': 'Unlimited source groups',
  '搜索源不限数量': 'Unlimited sources',
  '最多 {n} 个搜索源分组': 'Up to {n} source groups',
  '最多启用 {n} 个搜索源': 'Up to {n} sources',
  '不激活也能用，超出上限的部分需要会员': 'Works without activation; beyond the limits needs a membership',
  '激活后 365 天内，搜索源分组与搜索源都不限数量': 'Unlimited groups and sources for 365 days after activation',
  '一次激活，搜索源分组与搜索源长期不限数量': 'One activation, unlimited groups and sources for good',
  '{n} 个（不限）': '{n} (unlimited)',
  '{n} / {limit}': '{n} / {limit}',
  '未激活': 'Not activated',
  '已过期': 'Expired',
  '会员': 'Member',
  '{n} · {date} 到期': '{n} · expires {date}',
  '{n} · {date}': '{n} · {date}',
  '请输入激活码。': 'Enter an activation code.',
  '激活码格式不正确。': 'The activation code format is invalid.',
  '激活码无效。': 'The activation code is invalid.',
  '新建分组（会员不限数量）': 'New group (unlimited with a membership)',
  '新建分组（免费版还可建 {n} 个）': 'New group ({n} left on the free plan)',
  '免费版最多创建 {n} 个搜索源分组': 'The free plan allows {n} source groups',
  '添加搜索源（会员不限数量）': 'Add source (unlimited with a membership)',
  '添加搜索源（免费版还可启用 {n} 个）': 'Add source ({n} left on the free plan)',
  '免费版最多启用 {n} 个搜索源（可先关掉一个）': 'The free plan allows {n} sources (turn one off first)',
  '免费版最多创建 {n} 个搜索源分组。激活会员后不限数量，激活码在「关于」里。': 'The free plan allows {n} source groups. Activate a membership for unlimited groups — the code is under “About”.',
  '免费版最多启用 {n} 个搜索源，先关掉一个再新增；激活会员后不限数量，激活码在「关于」里。': 'The free plan allows {n} sources. Turn one off first, or activate a membership — the code is under “About”.',

  // 购买说明：付款码与微信号是中文界面的收款信息，但说明文字跟随界面语言。
  '购买与激活': 'Buying and activation',
  '扫码付款：一年会员 5 元，永久会员 10 元。付款成功后截图保存。': 'Scan to pay: ¥5 for one year, ¥10 for lifetime. Take a screenshot once the payment succeeds.',
  '扫码加我微信，验证信息备注「插件付费」；微信号：beta2meta。': 'Scan the code to add me on WeChat, with “plugin payment” in the request. WeChat ID: beta2meta.',
  '通过后把付款截图发给我。': 'Once accepted, send me the payment screenshot.',
  '核对到账后会回复激活码，填进上面的「激活码」再点「激活」即可。': 'After checking the payment I reply with an activation code — enter it above and click “Activate”.',
  '微信支付': 'WeChat Pay',
  '微信联系': 'WeChat',
  '微信收款码': 'WeChat payment QR code',
  '微信二维码': 'WeChat QR code',
  '微信扫码付款': 'Scan to pay with WeChat',
  '扫码添加好友': 'Scan to add me on WeChat',
  '付款前请核对收款方姓名，确认后再付款。': 'Check the payee name before paying.',

  '{n} 个搜索源': '{n} sources',
  '1 个搜索源': '1 source',
  '1 个站点': '1 site',
  '1 项': '1 item',
  '1 次提问': '1 question',
  '{n}按钮所在分组': 'Group for the {n} button',
  '{n} · 对话中': '{n} · chatting',
  '未添加': 'Not added',
  '当前站点': 'Current site',
  '当前分组搜索源': 'Sources in the current group',
  '历史对话': 'Chat history',
  '使用 QuickFind 搜索': 'Search with QuickFind',
  '使用{n}搜索': 'Search with {n}',
  '展开{n}': 'Expand {n}',
  '未命名笔记 {n}': 'Untitled note {n}',
  '请先在设置中填写 API 地址和模型。': 'Fill in the API endpoint and model in Settings first.',
  '先在页面上选中一段文字': 'Select some text on the page first',
  '新建': 'New',
  '导入': 'Import',
  '导入 JSON 或 Markdown': 'Import JSON or Markdown',
  '编辑历史': 'Edit history',
  '全部展开与收起': 'Expand or collapse all',
  '选中文字后，搜索按钮的触发方式': 'How the search button opens after selecting text',

  // ── 内置搜索源的名字与说明（英文界面用） ───────────────────────────
  '谷歌': 'Google',
  '百度': 'Baidu',
  '谷歌学术': 'Google Scholar',
  '360 搜索': '360 Search',
  '搜狗': 'Sogou',
  '哔哩哔哩': 'Bilibili',
  '小红书': 'Xiaohongshu',
  '知乎': 'Zhihu',
  '抖音': 'Douyin',
  '豆包': 'Doubao',
  '百度搜索': 'Baidu Search',
  '搜狗搜索': 'Sogou Search',
  '视频搜索': 'Video search',
  '内容搜索': 'Content search',
  '知乎搜索': 'Zhihu search',
  '抖音搜索': 'Douyin search',
  'AI 对话搜索': 'AI chat search',
  '打开新对话并填入内容': 'Open a new chat and fill in the text',
};

/** 内置源在英文界面下的名字。用户改过名（与中文默认名不一致）时不覆盖。 */
const BUILTIN_EN_NAMES: Record<string, string> = {
  google: 'Google',
  baidu: 'Baidu',
  'google-scholar': 'Google Scholar',
  duckduckgo: 'DuckDuckGo',
  so: '360 Search',
  sogou: 'Sogou',
  bing: 'Bing',
  yandex: 'Yandex',
  'google-ai': 'Google AI Mode',
  bilibili: 'Bilibili',
  xiaohongshu: 'Xiaohongshu',
  x: 'X',
  youtube: 'YouTube',
  zhihu: 'Zhihu',
  douyin: 'Douyin',
  doubao: 'Doubao',
  deepseek: 'DeepSeek',
};

/** 内置源在中文界面下的默认名，用来判断「这个名字是不是用户改过的」。 */
const BUILTIN_ZH_NAMES: Record<string, string> = {
  google: '谷歌',
  baidu: '百度',
  'google-scholar': '谷歌学术',
  duckduckgo: 'DuckDuckGo',
  so: '360 搜索',
  sogou: '搜狗',
  bing: 'Bing',
  yandex: 'Yandex',
  'google-ai': 'Google AI Mode',
  bilibili: '哔哩哔哩',
  xiaohongshu: '小红书',
  x: 'X',
  youtube: 'YouTube',
  zhihu: '知乎',
  douyin: '抖音',
  doubao: '豆包',
  deepseek: 'DeepSeek',
};

/**
 * 界面上的源名。
 *
 * 内置源的名字随界面语言变化；用户自己建的源、以及被改过名的内置源一律照存储显示——
 * 那是用户输入的内容，翻译它等于篡改数据。
 */
export function sourceLabel(source: { id?: unknown; name?: unknown } | null | undefined): string {
  const name = String(source?.name ?? '');
  const id = String(source?.id ?? '');
  if (currentLocale !== 'en') return name;
  const localized = BUILTIN_EN_NAMES[id];
  return localized && BUILTIN_ZH_NAMES[id] === name ? localized : name;
}

/** 动作在中文界面下的默认名，用来判断「这个名字是不是用户改过的」。 */
const ACTION_ZH_NAMES: Record<string, string> = { copy: '复制', notes: '笔记', 'ask-ai': '问 ai' };

/**
 * 特殊功能按钮在界面上的名字。
 *
 * 归一化后的动作条目把 `id` 换成了 `action:<id>` 令牌，所以按 `action` 字段认。
 * 用户改过名（与默认名不一致）时照显示改过的名字——那是用户输入的内容。
 */
export function actionLabel(entry: { action?: unknown; name?: unknown } | null | undefined): string {
  const name = String(entry?.name ?? '');
  const action = String(entry?.action ?? '');
  if (currentLocale !== 'en') return name;
  return ACTION_ZH_NAMES[action] === name ? EN[name] ?? name : name;
}

/**
 * 特殊功能按钮的悬浮提示。
 *
 * 改过名的按钮优先用改过的名字：只显示图标时，悬浮提示是唯一能看到它的地方，
 * 还写默认说明等于改名没生效。没改名时才用动作自带的说明（「复制搜索内容」这类）。
 */
export function actionTooltip(entry: { action?: unknown; name?: unknown; specialTitle?: unknown } | null | undefined): string {
  const name = String(entry?.name ?? '');
  const action = String(entry?.action ?? '');
  const defaultName = ACTION_ZH_NAMES[action];
  if (name && defaultName && name !== defaultName) return name;
  const title = String(entry?.specialTitle ?? '');
  return title ? t(title) : actionLabel(entry);
}

/** 分组名：只翻译随扩展附带的默认组与预设组，用户自建/改名的分组照原样显示。 */
export function groupLabel(group: { id?: unknown; name?: unknown } | null | undefined): string {
  const name = String(group?.name ?? '');
  const id = String(group?.id ?? '');
  if (currentLocale !== 'en') return name;
  if (id === 'default' && (name === '默认组' || name === '默认')) return t('默认组');
  if (id === 'group-video' && name === '视频') return t('视频');
  return name;
}

/** 把 `{name}` 占位符换成变量值。缺变量时保留占位符本身，便于发现漏传。 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

/**
 * 取当前语言下的文案。
 *
 * 找不到英文时回落到中文源文案——漏译的后果是「这一句还是中文」，而不是空白或键名。
 */
export function t(message: string, vars?: Record<string, string | number>): string {
  const template = currentLocale === 'en' ? EN[message] ?? message : message;
  return interpolate(template, vars);
}

/**
 * 带数量的文案。英文的 1 与复数形式不同，中文两者用同一句话——
 * 调用方给一对键（单数、复数），由这里按 count 选。
 */
export function countText(count: number, one: string, many: string): string {
  return t(count === 1 ? one : many, { n: count });
}

/** 给静态 HTML 打标后调用一次：`data-i18n*` 属性决定翻译哪一部分。 */
export function applyI18n(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n || '');
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((element) => {
    element.title = t(element.dataset.i18nTitle || '');
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel || ''));
  });
  // 图片的替代文字也要跟着语言走，否则英文界面里读屏念的是中文。
  root.querySelectorAll<HTMLElement>('[data-i18n-alt]').forEach((element) => {
    element.setAttribute('alt', t(element.dataset.i18nAlt || ''));
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.placeholder = t(element.dataset.i18nPlaceholder || '');
    }
  });
}