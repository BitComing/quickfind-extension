// 特殊功能按钮在分组里的三项能力（2026-11-07 需求）。
//
// 需求原文：「特殊功能按钮在分组中可以多选、删除、仅图标」——也就是与搜索源行对齐：
// 复选框（多选，批移/批删都认 `action:<id>`）、删除按钮、仅图标开关。
//
// 这里测真实产物：三个控件在行上、仅图标落盘为 specialActions 且真的让浮层只画图标、
// 多选后能批移与批删。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const PANEL_HOST = '#quickfind-shadow-host';

const PAGE = '<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">'
  + '<p id="text" style="width:460px;line-height:2">这段话用来产生选区，看浮层里「复制」按钮是不是只剩图标。</p></body>';

/** 一组固定的初始配置：默认组放两个特殊功能按钮 + 一个搜索源。 */
const SEED = {
  groups: [
    { id: 'default', name: '默认组', items: ['google', 'action:copy', 'action:ask-ai'], visible: true },
    { id: 'group-work', name: '工作', items: ['baidu'], visible: true },
  ],
  specialActions: {},
  triggerMode: 'click',
  editableTriggerMode: 'none',
  defaultGroupCount: 20,
  pinnedSearch: { sites: [], customSites: [], allSites: false, siteConfigVersion: 3, collapseDelay: 250, defaultGroupCount: 10, openInNewTab: true },
};

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    await page.evaluate((seed) => new Promise((resolve) => chrome.storage.sync.set(seed, resolve)), SEED);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="sources"]'));
    await page.click('.nav-item[data-panel="sources"]');
    await page.waitForTimeout(250);

    const rowState = (actionId) => page.evaluate((id) => {
      const row = document.querySelector(`.source-row.special-action-row[data-action-id="${id}"]`);
      if (!row) return null;
      const checkbox = row.querySelector('.source-select input');
      const iconOnly = row.querySelector('.icon-only-setting input');
      return {
        hasCheckbox: Boolean(checkbox),
        hasIconOnly: Boolean(iconOnly),
        hasRemove: Boolean(row.querySelector('button[title="从分组移除"]')),
        checked: checkbox ? checkbox.checked : null,
        iconOnlyChecked: iconOnly ? iconOnly.checked : null,
        name: row.querySelector('.source-meta strong')?.textContent?.trim() || '',
      };
    }, actionId);

    const readStorage = (keys) => page.evaluate((list) => new Promise((resolve) => chrome.storage.sync.get(list, resolve)), keys);

    // ── 1. 行上的三个控件 ───────────────────────────────────────────
    console.log('【1】特殊功能按钮行与搜索源行对齐：多选 / 删除 / 仅图标');
    const copyRow = await rowState('copy');
    check('「复制」按钮在分组列表里', copyRow?.name === '复制', JSON.stringify(copyRow));
    check('行上有复选框（多选）', copyRow?.hasCheckbox === true);
    check('行上有删除按钮', copyRow?.hasRemove === true);
    check('行上有仅图标开关', copyRow?.hasIconOnly === true);
    const askRow = await rowState('ask-ai');
    check('「问 ai」同样有三件控件', askRow?.hasCheckbox === true && askRow?.hasRemove === true && askRow?.hasIconOnly === true, JSON.stringify(askRow));
    console.log('');

    // ── 2. 仅图标 ───────────────────────────────────────────────────
    console.log('【2】仅图标写入 specialActions 并传到浮层');
    await page.locator('.source-row.special-action-row[data-action-id="copy"] .icon-only-setting input').check();
    await page.waitForTimeout(250);
    const savedIconOnly = await readStorage(['specialActions']);
    check('仅图标落盘为 specialActions.copy.iconOnly', savedIconOnly.specialActions?.copy?.iconOnly === true, JSON.stringify(savedIconOnly.specialActions));

    const page2 = await env.context.newPage();
    await page2.goto(await env.serve(PAGE));
    await page2.waitForTimeout(1200);
    await page2.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await page2.waitForTimeout(350);
    await page2.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await page2.waitForTimeout(300);
    const floating = await page2.evaluate((selector) => {
      const root = document.querySelector(selector)?.shadowRoot;
      const entry = root?.querySelector('.engine.special-copy');
      if (!entry) return null;
      const label = entry.querySelector('.engine-name');
      return {
        iconOnlyClass: entry.classList.contains('icon-only'),
        labelDisplay: label ? getComputedStyle(label).display : 'missing',
        title: entry.getAttribute('title'),
      };
    }, PANEL_HOST);
    check('浮层里「复制」带 icon-only 类', floating?.iconOnlyClass === true, JSON.stringify(floating));
    check('浮层里「复制」不显示文字', floating?.labelDisplay === 'none', floating?.labelDisplay);
    check('仅图标后仍保留悬浮提示', String(floating?.title || '').length > 0, floating?.title);
    await page2.close();
    console.log('');

    // ── 3. 多选 + 批量移动 ─────────────────────────────────────────
    console.log('【3】多选两个按钮并批量移动到另一个分组');
    await page.locator('.source-row.special-action-row[data-action-id="copy"] .source-select input').check();
    await page.locator('.source-row.special-action-row[data-action-id="ask-ai"] .source-select input').check();
    await page.waitForTimeout(150);
    const batch = await page.evaluate(() => ({
      visible: !document.querySelector('#batch-actions').hidden,
      count: document.querySelector('#batch-count').textContent.trim(),
      options: Array.from(document.querySelectorAll('#batch-group option')).map((option) => option.textContent.trim()),
    }));
    check('选了两个按钮后出现批量工具条', batch.visible === true);
    check('批量工具条显示「已选 2 项」', batch.count === '已选 2 项', batch.count);
    check('批移下拉里列出分组', batch.options.includes('工作'), JSON.stringify(batch.options));

    await page.selectOption('#batch-group', { label: '工作' });
    await page.waitForTimeout(300);
    const moved = await readStorage(['groups']);
    const workItems = (moved.groups || []).find((group) => group.id === 'group-work')?.items || [];
    const defaultItems = (moved.groups || []).find((group) => group.id === 'default')?.items || [];
    check('两个按钮都移到了「工作」', workItems.includes('action:copy') && workItems.includes('action:ask-ai'), JSON.stringify(workItems));
    check('默认组里不再有这两个按钮', !defaultItems.includes('action:copy') && !defaultItems.includes('action:ask-ai'), JSON.stringify(defaultItems));
    console.log('');

    // ── 4. 多选 + 批量删除 ─────────────────────────────────────────
    console.log('【4】多选后批量删除');
    await page.click('.group-tab:has-text("工作")');
    await page.waitForTimeout(250);
    await page.locator('.source-row.special-action-row[data-action-id="copy"] .source-select input').check();
    await page.locator('.source-row.special-action-row[data-action-id="ask-ai"] .source-select input').check();
    await page.waitForTimeout(150);
    await page.click('#batch-delete');
    await page.waitForTimeout(300);
    const afterDelete = await page.evaluate(() => ({
      rows: document.querySelectorAll('.source-row.special-action-row').length,
      palette: Array.from(document.querySelectorAll('.special-action-config select')).map((select) => select.value),
    }));
    check('列表里不再有特殊功能按钮行', afterDelete.rows === 0, String(afterDelete.rows));
    check('上方调色板的两个按钮回到「未添加」', afterDelete.palette.every((value) => value === ''), JSON.stringify(afterDelete.palette));
    const deleted = await readStorage(['groups']);
    const anyAction = (deleted.groups || []).some((group) => (group.items || []).some((item) => String(item).startsWith('action:')));
    check('存储里不再有任何 action 条目', anyAction === false, JSON.stringify(deleted.groups));

    // ── 5. 单行删除 ─────────────────────────────────────────────────
    console.log('【5】单行删除按钮');
    await page.evaluate((seed) => new Promise((resolve) => chrome.storage.sync.set({ groups: seed.groups }, resolve)), SEED);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="sources"]'));
    await page.click('.nav-item[data-panel="sources"]');
    await page.waitForTimeout(250);
    await page.locator('.source-row.special-action-row[data-action-id="copy"] button[title="从分组移除"]').click();
    await page.waitForTimeout(250);
    const afterRemove = await page.evaluate(() => Array.from(document.querySelectorAll('.source-row.special-action-row')).map((row) => row.dataset.actionId));
    check('单行删除后只剩「问 ai」', afterRemove.join(',') === 'ask-ai', JSON.stringify(afterRemove));
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });