/**
 * 全新安装的默认配置（2026-11-07）：
 * 默认组直排小红书 / Bing / 知乎 / 哔哩哔哩，另有一个「视频」分组放抖音；
 * 其余内置源保留在目录里但默认不启用（旧版免费版按「已启用」数量计 20 个上限；
 * 现在付费功能已下线，配额不限，见 verify-about-free-2026-11-10.cjs）。
 *
 * 关键在「先手入口」：全新安装时用户可能先点工具栏弹窗（选项页还没打开过），
 * 也可能先在网页上选中文字。三个入口必须看到同一份默认配置——弹窗此前在空存储上走
 * 旧版回落路径，会把 17 个内置源全部启用。这里先用空 profile 打开弹窗，再打开选项页落盘，
 * 最后核对弹窗、常驻栏、存储三处一致。
 */

const { createChecker, launchWithExtension, waitExtensionReady } = require('./helpers.cjs');

const { check, summary } = createChecker();

/** 弹窗默认组里的条目（按显示顺序）：4 个搜索源 + 「视频」分组入口。 */
const DEFAULT_NAMES = ['小红书', 'Bing', '知乎', '哔哩哔哩', '视频'];

const readPopup = (page) => page.evaluate(() => ({
  tabs: Array.from(document.querySelectorAll('#group-tabs .group-tab')).map((tab) => tab.textContent.trim()),
  rows: Array.from(document.querySelectorAll('#engine-settings .engine-row'))
    .map((row) => (row.querySelector('.engine-ident strong')?.textContent || '').trim()),
}));

(async () => {
  const env = await launchWithExtension();
  try {
    // ---------- 1. 全新 profile：先开弹窗 ----------
    console.log('【1】全新安装，先开弹窗（选项页还没打开过）');
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup.waitForSelector('#engine-settings .engine-row');
    await popup.waitForTimeout(300);
    let state = await readPopup(popup);
    check('标签为「默认组 + 视频」', state.tabs.join(',') === '默认组,视频', JSON.stringify(state.tabs));
    check('默认组里是 4 个源 +「视频」入口', state.rows.join(',') === DEFAULT_NAMES.join(','), JSON.stringify(state.rows));

    await popup.evaluate(() => {
      Array.from(document.querySelectorAll('#engine-settings .engine-row'))
        .find((row) => String(row.getAttribute('title') || '').startsWith('打开视频'))
        ?.click();
    });
    await popup.waitForTimeout(250);
    state = await readPopup(popup);
    check('「视频」分组里是抖音', state.rows.join(',') === '抖音', JSON.stringify(state.rows));
    console.log('');

    // ---------- 2. 选项页落盘后的存储 ----------
    console.log('【2】打开选项页后，默认配置落盘');
    const options = await env.openOptionsPage();
    const stored = await options.evaluate(() => new Promise((resolve) => chrome.storage.sync.get(['sources', 'groups'], resolve)));
    const sources = stored.sources || [];
    const enabled = sources.filter((source) => source.enabled !== false).map((source) => source.id).sort();
    check('内置源目录仍保留 17 个（其余只是不启用）', sources.length === 17, String(sources.length));
    check('默认启用 4 个直排源 + 抖音', enabled.join(',') === ['bilibili', 'bing', 'douyin', 'xiaohongshu', 'zhihu'].join(','), JSON.stringify(enabled));
    check('分组为「默认组 + 视频」', (stored.groups || []).map((group) => group.name).join(',') === '默认组,视频', JSON.stringify((stored.groups || []).map((group) => group.name)));
    const video = (stored.groups || []).find((group) => group.id === 'group-video');
    check('「视频」分组里只有抖音', JSON.stringify(video?.items) === JSON.stringify(['douyin']), JSON.stringify(video?.items));
    console.log('');

    // ---------- 3. 落盘后弹窗与常驻栏读到同一份 ----------
    console.log('【3】落盘后，弹窗与常驻栏看到同一份默认配置');
    await popup.reload();
    await popup.waitForSelector('#engine-settings .engine-row');
    await popup.waitForTimeout(300);
    state = await readPopup(popup);
    check('弹窗重载后仍是 4 个源 +「视频」', state.rows.join(',') === DEFAULT_NAMES.join(','), JSON.stringify(state.rows));

    const url = await env.serve('<!doctype html><meta charset="utf-8"><body><p>QuickFind 默认配置验证页</p></body>');
    const page = await env.context.newPage();
    await page.goto(url);
    await waitExtensionReady(page);
    const pinned = await page.evaluate(() => {
      const root = document.querySelector('#quickfind-pinned-search-host')?.shadowRoot;
      return root ? Array.from(root.querySelectorAll('.entries .entry')).map((entry) => (entry.getAttribute('title') || '').trim()) : [];
    });
    check('常驻栏也是 4 个源 +「视频」分组', pinned.length === 5
      && pinned.slice(0, 4).every((title, index) => title.includes(DEFAULT_NAMES[index]))
      && pinned[4].includes('视频'), JSON.stringify(pinned));

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });