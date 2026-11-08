/**
 * 弹窗「该重建才重建」的回归用例。
 *
 * 背景：弹窗原先只要 `chrome.storage.onChanged` 一响，就整份重取 + 全量重建分组标签与
 * 全部搜索源行。而常驻栏、笔记、LLM、搜索历史这些模块写存储的频率与弹窗内容毫无关系
 * ——弹窗开着的时候，这些回声会让整排搜索源重新立节点、正在拖动的标签状态被抹掉。
 * 现在渲染前先算一份结构指纹（分组、顺序、当前分组下的条目及其图标/名称/地址），
 * 指纹不变就只更新历史列表。
 *
 * 断言必须落在**节点身份**上，不能只看「内容一样」：内容一样恰恰是重建之后也会成立的结果，
 * 那样的断言对本次改动恒真。所以这里先给每个搜索源行打标记，再触发一次无关写入，
 * 标记还在 = 没重建。
 *
 * 同时要有对照断言：真正影响呈现的写入（分组改名、切换分组、历史变化）必须让界面跟上，
 * 否则「不重建」这条契约可以被一次彻底不渲染的回归冒充过去。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const { check, summary } = createChecker();

const SOURCE = (id, name, mark, url, className) => ({ id, name, mark, detail: '', url, className, enabled: true, iconOnly: false, iconUrl: '' });

const config = () => ({
  enabled: true,
  sources: [
    SOURCE('google', '谷歌', 'G', 'https://www.google.com/search?q={query}', 'google'),
    SOURCE('baidu', '百度', '百', 'https://www.baidu.com/s?wd={query}', 'baidu'),
    SOURCE('bilibili', '哔哩哔哩', 'B', 'https://search.bilibili.com/all?keyword={query}', 'bilibili'),
    SOURCE('zhihu', '知乎', '知', 'https://www.zhihu.com/search?q={query}', 'zhihu'),
  ],
  groups: [
    { id: 'default', name: '默认分组', items: ['google', 'baidu', 'group:video'], visible: true },
    { id: 'video', name: '视频', items: ['bilibili', 'zhihu'], visible: true },
  ],
  engineOrder: ['google', 'baidu'],
  sourceConfigVersion: 5,
  searchHistory: [
    { query: '第一条历史', timestamp: 1 },
    { query: '第二条历史', timestamp: 2 },
  ],
  pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
  triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: false,
});

/** 弹窗当前状态：标签、搜索源行、历史条目，外加「打标记的节点还在不在」。 */
const popupState = (page) => page.evaluate(() => ({
  tabs: Array.from(document.querySelectorAll('#group-tabs .group-tab')).map((tab) => ({
    name: tab.textContent, active: tab.classList.contains('active'), probe: tab.dataset.qfProbe || null,
  })),
  rows: Array.from(document.querySelectorAll('#engine-settings .engine-row')).map((row) => ({
    name: row.querySelector('.engine-ident strong')?.textContent || '',
    probe: row.dataset.qfProbe || null,
  })),
  history: Array.from(document.querySelectorAll('#history-list .history-item')).map((item) => item.textContent),
}));

const probeAll = (page) => page.evaluate(() => {
  const stamp = String(Date.now());
  document.querySelectorAll('#group-tabs .group-tab').forEach((tab, index) => { tab.dataset.qfProbe = `tab${index}@${stamp}`; });
  document.querySelectorAll('#engine-settings .engine-row').forEach((row, index) => { row.dataset.qfProbe = `row${index}@${stamp}`; });
  return stamp;
});

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    const setConfig = (value) => optionsPage.evaluate((payload) => new Promise((r) => chrome.storage.sync.set(payload, r)), value);
    const setSync = (value) => optionsPage.evaluate((payload) => new Promise((r) => chrome.storage.sync.set(payload, r)), value);

    await setConfig(config());
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup.waitForSelector('#engine-settings .engine-row', { timeout: 8000 });
    await popup.waitForTimeout(300);

    // ---------- 1. 首屏 ----------
    console.log('【1】首屏渲染');
    let state = await popupState(popup);
    check('分组标签 = 默认分组 + 视频', state.tabs.map((t) => t.name).join(',') === '默认分组,视频', JSON.stringify(state.tabs.map((t) => t.name)));
    check('默认分组处于选中态', state.tabs[0]?.active === true, JSON.stringify(state.tabs.map((t) => t.active)));
    check('搜索源行 = 谷歌 / 百度 /「视频」分组入口', state.rows.map((r) => r.name).join(',') === '谷歌,百度,视频', state.rows.map((r) => r.name).join(','));
    check('历史列表有两条', state.history.length === 2, JSON.stringify(state.history));
    console.log('');

    // ---------- 2. 与弹窗无关的存储写入不重建 ----------
    console.log('【2】与弹窗内容无关的写入（常驻栏 / 笔记 / 任意键）不重建');
    const stamp = await probeAll(popup);
    for (let i = 0; i < 3; i += 1) await setSync({ [`qf-probe-${i}`]: i });
    await setSync({ pinnedSearch: Object.assign({}, config().pinnedSearch, { collapseDelay: 12000 }) });
    await popup.waitForTimeout(400);
    state = await popupState(popup);
    check('分组标签节点未被替换（修复点）', state.tabs.every((t) => t.probe === `tab${state.tabs.indexOf(t)}@${stamp}`),
      JSON.stringify(state.tabs.map((t) => t.probe)));
    check('搜索源行节点未被替换（修复点）', state.rows.every((r) => r.probe === `row${state.rows.indexOf(r)}@${stamp}`),
      JSON.stringify(state.rows.map((r) => r.probe)));
    check('内容仍然是对的（不是靠不渲染冒充）', state.rows.map((r) => r.name).join(',') === '谷歌,百度,视频', state.rows.map((r) => r.name).join(','));
    console.log('');

    // ---------- 3. 真正影响呈现的写入必须重建 ----------
    console.log('【3】真变了就要跟上');
    const next = config();
    next.groups[1].name = '视频搜索';
    await setConfig(next);
    await popup.waitForTimeout(400);
    state = await popupState(popup);
    check('分组改名后标签跟上（修复点）', state.tabs.map((t) => t.name).join(',') === '默认分组,视频搜索', JSON.stringify(state.tabs.map((t) => t.name)));
    check('改名后节点确实被重建（对照组，证明上一条不是靠缓存旧 DOM）',
      state.tabs.some((t) => t.probe === null || t.probe.endsWith('@' + stamp) === false),
      JSON.stringify(state.tabs.map((t) => t.probe)));

    await popup.locator('#group-tabs .group-tab').nth(1).click();
    await popup.waitForTimeout(300);
    state = await popupState(popup);
    check('切到「视频」分组后行跟着换', state.rows.map((r) => r.name).join(',') === '哔哩哔哩,知乎', state.rows.map((r) => r.name).join(','));
    check('当前分组高亮跟着换', state.tabs[1]?.active === true && state.tabs[0]?.active === false, JSON.stringify(state.tabs.map((t) => t.active)));
    console.log('');

    // ---------- 4. 历史变化要进列表 ----------
    console.log('【4】历史变化');
    await setSync({ searchHistory: [{ query: '新的一次搜索', timestamp: 3 }, { query: '第一条历史', timestamp: 1 }] });
    await popup.waitForTimeout(400);
    state = await popupState(popup);
    check('历史列表跟着更新', state.history.join(',') === '新的一次搜索,第一条历史', JSON.stringify(state.history));
    await setSync({ searchHistory: [] });
    await popup.waitForTimeout(400);
    state = await popupState(popup);
    check('清空后显示空态', state.history.length === 0, JSON.stringify(state.history));
    const emptyText = await popup.evaluate(() => document.querySelector('#history-list .history-empty')?.textContent || '');
    check('空态文案在位', emptyText.includes('暂无搜索历史'), emptyText);
    console.log('');
  } finally {
    await env.close();
  }
  process.exit(summary());
})();