// 设置页外壳回归：白色主题、滚动条不挤压版心、搜索源改弹窗、「常用设置」合并页。
//
// 这四项都是「看起来对不对」的改动，最容易在后续重构里被悄悄改回去，
// 所以断言直接对着真实产物测：计算样式、布局矩形、弹窗的 open 状态与落盘配置。

const path = require('path');
const fs = require('fs');
const { launchWithExtension } = require('./helpers.cjs');
const { createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const SHOTS = path.resolve(__dirname, '..', 'output', 'shots');

/** 三十条历史记录：让「历史记录」页在 600px 高的视口里一定溢出，用来触发滚动条。 */
const HISTORY = Array.from({ length: 30 }, (_item, index) => ({
  query: '滚动条测试查询 ' + (index + 1),
  timestamp: Date.now() - index * 60_000,
}));

async function layoutLeft(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.settings-layout').getBoundingClientRect();
    const root = document.documentElement;
    return {
      left: Math.round(rect.left * 100) / 100,
      scrollable: root.scrollHeight > root.clientHeight,
      gutter: getComputedStyle(root).scrollbarGutter,
    };
  });
}

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    await page.evaluate((history) => new Promise((resolve) => chrome.storage.sync.set({ searchHistory: history }, resolve)), HISTORY);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#source-dialog') && document.querySelector('.nav-item'));

    // ── 1. 白色主题 ──────────────────────────────────────────────────
    console.log('【1】主题为白：画布纯白、导航选中态中性灰');
    const theme = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const active = document.querySelector('.nav-item.active');
      const parse = (value) => (value.match(/\d+(\.\d+)?/g) || []).map(Number);
      return {
        canvas: root.getPropertyValue('--qf-canvas').trim(),
        body: getComputedStyle(document.body).backgroundColor,
        navBg: active ? getComputedStyle(active).backgroundColor : '',
        navRgb: active ? parse(getComputedStyle(active).backgroundColor) : [],
        cardBg: getComputedStyle(document.querySelector('.rows')).backgroundColor,
        line: root.getPropertyValue('--qf-line').trim(),
      };
    });
    const navChroma = theme.navRgb.length === 3 ? Math.max(...theme.navRgb) - Math.min(...theme.navRgb) : 999;
    check('--qf-canvas 是纯白', theme.canvas.toLowerCase() === '#ffffff', theme.canvas);
    check('body 背景解析为 rgb(255, 255, 255)', theme.body === 'rgb(255, 255, 255)', theme.body);
    check('卡片背景为白', theme.cardBg === 'rgb(255, 255, 255)', theme.cardBg);
    check('导航选中态不再带绿灰偏色', navChroma <= 4, `${theme.navBg}（色差 ${navChroma}）`);
    console.log('');

    // ── 2. 滚动条占位：切页时版心不动 ────────────────────────────────
    console.log('【2】滚动条出现时不挤压版心');
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.click('.nav-item[data-panel="common"]');
    await page.waitForTimeout(200);
    const shortPanel = await layoutLeft(page);
    await page.click('.nav-item[data-panel="history"]');
    await page.waitForTimeout(250);
    const longPanel = await layoutLeft(page);
    check('滚动条槽位稳定（scrollbar-gutter: stable）', longPanel.gutter === 'stable', longPanel.gutter);
    check('短面板不产生纵向滚动', shortPanel.scrollable === false, JSON.stringify(shortPanel));
    check('长面板确实溢出（滚动条已出现）', longPanel.scrollable === true, JSON.stringify(longPanel));
    check('切页后版心左偏移不变', Math.abs(longPanel.left - shortPanel.left) < 0.5, `${shortPanel.left} → ${longPanel.left}`);
    await page.setViewportSize({ width: 1180, height: 900 });
    console.log('');

    // ── 3. 「常用设置」合并页 ───────────────────────────────────────
    console.log('【3】选中文字与常驻搜索栏合并为「常用设置」');
    const nav = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).map((item) => ({
      label: item.textContent.trim(),
      panel: item.dataset.panel,
    })));
    check('导航里只剩一页承担这两项设置', nav.filter((item) => item.panel === 'common').length === 1, JSON.stringify(nav));
    check('旧的「选中文字」「常驻搜索栏」导航项已移除', !nav.some((item) => item.panel === 'selection' || item.panel === 'pinned'), JSON.stringify(nav));
    await page.click('.nav-item[data-panel="common"]');
    await page.waitForTimeout(200);
    const merged = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="common"]');
      if (!panel) return null;
      const panelVisible = !panel.hidden && getComputedStyle(panel).display !== 'none';
      return {
        panelVisible,
        headings: Array.from(panel.querySelectorAll('.setting-block h3')).map((node) => node.textContent.trim()),
        hasTrigger: Boolean(panel.querySelector('input[name="trigger-mode"]')),
        hasEditableTrigger: Boolean(panel.querySelector('input[name="editable-trigger-mode"]')),
        hasPinnedSites: Boolean(panel.querySelector('#manage-pinned-sites')),
        hasAllSites: Boolean(panel.querySelector('#pinned-all-sites')),
        saveStates: ['#selection-save-state', '#pinned-save-state'].every((selector) => panel.querySelector(selector)),
        stalePanels: document.querySelectorAll('[data-panel-content="selection"], [data-panel-content="pinned"]').length,
      };
    });
    check('「常用设置」面板存在且可见', merged?.panelVisible === true, JSON.stringify(merged));
    check('面板内同时含选中文字与常驻搜索栏两组设置', merged?.hasTrigger && merged?.hasEditableTrigger && merged?.hasPinnedSites && merged?.hasAllSites, JSON.stringify(merged));
    check('两个分组的标题都在同一页', String(merged?.headings).includes('选中文字') && String(merged?.headings).includes('常驻搜索栏'), String(merged?.headings));
    check('两个保存状态位都保留', merged?.saveStates === true);
    check('旧的两个面板节点已删除', merged?.stalePanels === 0, String(merged?.stalePanels));
    console.log('');

    // ── 4. 搜索源：按钮 + 弹窗 ─────────────────────────────────────
    console.log('【4】「添加搜索源」改为按钮 + 弹窗');
    await page.click('.nav-item[data-panel="sources"]');
    await page.waitForTimeout(200);
    const shell = await page.evaluate(() => {
      const button = document.querySelector('#add-source');
      const dialog = document.querySelector('#source-dialog');
      return {
        buttonVisible: Boolean(button && button.getBoundingClientRect().width > 0),
        buttonText: button?.textContent.trim() || '',
        dialogOpen: Boolean(dialog?.open),
        formInsidePanel: Boolean(document.querySelector('[data-panel-content="sources"] #source-form')),
      };
    });
    check('「添加搜索源」按钮可见', shell.buttonVisible === true, shell.buttonText);
    check('弹出表单已不在列表页内联渲染', shell.formInsidePanel === false);
    check('弹窗初始为关闭', shell.dialogOpen === false);

    await page.click('#add-source');
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      title: document.querySelector('#form-title').textContent.trim(),
      submit: document.querySelector('#submit-label').textContent.trim(),
      focused: document.activeElement?.id,
    }));
    check('点击按钮打开弹窗', opened.open === true);
    check('标题为「添加搜索源」', opened.title === '添加搜索源', opened.title);
    check('焦点落在名称输入框', opened.focused === 'source-name', opened.focused);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'after-source-dialog.png') });

    await page.fill('#source-name', '测试源');
    await page.fill('#source-mark', 'T');
    await page.fill('#source-url', 'https://example.com/search');
    await page.click('#source-form .primary-button');
    await page.waitForTimeout(150);
    const invalid = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      error: document.querySelector('#form-error').textContent.trim(),
    }));
    check('缺少 {query} 时弹窗不关闭', invalid.open === true);
    check('错误提示仍在弹窗内展示', invalid.error.includes('{query}'), invalid.error);

    await page.fill('#source-url', 'https://example.com/search?q={query}');
    await page.click('#source-form .primary-button');
    await page.waitForTimeout(300);
    const added = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      rowText: Array.from(document.querySelectorAll('#source-list .source-row strong')).map((node) => node.textContent.trim()),
    }));
    check('提交后弹窗关闭', added.open === false);
    check('新搜索源出现在列表里', added.rowText.includes('测试源'), JSON.stringify(added.rowText));

    await page.locator('.source-row', { hasText: '测试源' }).locator('button[title="编辑搜索源"]').click();
    await page.waitForTimeout(200);
    const editing = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      title: document.querySelector('#form-title').textContent.trim(),
      name: document.querySelector('#source-name').value,
      submit: document.querySelector('#submit-label').textContent.trim(),
    }));
    check('编辑图标打开同一个弹窗', editing.open === true);
    check('弹窗切换为「编辑搜索源」', editing.title === '编辑搜索源' && editing.submit === '保存', `${editing.title}/${editing.submit}`);
    check('弹窗预填原有名称', editing.name === '测试源', editing.name);

    await page.fill('#source-name', '测试源改');
    await page.click('#source-form .primary-button');
    await page.waitForTimeout(300);
    const renamed = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      rowText: Array.from(document.querySelectorAll('#source-list .source-row strong')).map((node) => node.textContent.trim()),
    }));
    check('保存后弹窗关闭', renamed.open === false);
    check('列表就地更新为新名称', renamed.rowText.includes('测试源改') && !renamed.rowText.includes('测试源'), JSON.stringify(renamed.rowText));

    await page.click('#add-source');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const escaped = await page.evaluate(() => ({
      open: document.querySelector('#source-dialog').open,
      title: document.querySelector('#form-title').textContent.trim(),
    }));
    check('Esc 关闭弹窗', escaped.open === false);
    check('再次打开时回到「添加」态', escaped.title === '添加搜索源', escaped.title);

    const persisted = await page.evaluate(() => new Promise((resolve) => chrome.storage.sync.get(['sources'], (all) => resolve((all.sources || []).map((source) => source.name)))));
    check('改动已写入 sync 存储', persisted.includes('测试源改'), JSON.stringify(persisted));
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });