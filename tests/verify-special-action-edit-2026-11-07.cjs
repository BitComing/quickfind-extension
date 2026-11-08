// 特殊功能按钮在分组里可改名、可启用/停用（2026-11-07 需求）。
//
// 需求原文：「在分组内，特殊功能按钮一样可以编辑名称，也可以选择启用和不启用」。
// 与搜索源行对齐：铅笔按钮改名、最右一列控制启用；停用后三个入口都不再画它。
//
// 测真实产物：改名落盘为 specialActions.<id>.name、停用落盘为 enabled:false，
// 并且浮层真的按这两项显示或隐藏。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const PANEL_HOST = '#quickfind-shadow-host';

const PAGE = '<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">'
  + '<p id="text" style="width:460px;line-height:2">这段文字用来产生选区，验证特殊功能按钮的改名与停用。</p></body>';

/** 默认组放两个特殊功能按钮 + 一个搜索源；另有一个分组用来确认改名不影响归属。 */
const GROUPS = [
  { id: 'default', name: '默认组', items: ['action:copy', 'action:ask-ai', 'bing'], visible: true },
  { id: 'group-work', name: '工作', items: ['zhihu'], visible: true },
];

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();

    // 改名/删除分组用的是 window.prompt，先把对话框接住。
    let pendingPrompt = '';
    let lastDialog = { type: null };
    page.on('dialog', async (dialog) => {
      lastDialog = { type: dialog.type() };
      await dialog.accept(dialog.type() === 'prompt' ? pendingPrompt : undefined);
    });

    const readStorage = (keys) => page.evaluate((list) => new Promise((resolve) => chrome.storage.sync.get(list, resolve)), keys);
    const openSources = async () => {
      await page.click('.nav-item[data-panel="sources"]');
      await page.waitForTimeout(250);
    };

    await page.evaluate((groups) => new Promise((resolve) => chrome.storage.sync.set({ groups }, resolve)), GROUPS);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="sources"]'));
    await openSources();

    const rowState = (actionId) => page.evaluate((id) => {
      const row = document.querySelector(`.source-row.special-action-row[data-action-id="${id}"]`);
      if (!row) return null;
      return {
        name: row.querySelector('.source-meta strong')?.textContent?.trim() || '',
        hasRename: Boolean(row.querySelector('button[title="重命名按钮"]')),
        enabledChecked: row.querySelector('.check input')?.checked ?? null,
        paletteName: Array.from(document.querySelectorAll('.special-action-config strong'))
          .map((node) => node.textContent.trim()),
      };
    }, actionId);

    // ── 1. 行上的改名入口 ───────────────────────────────────────────
    console.log('【1】特殊功能按钮行有「重命名」按钮，默认名来自动作定义');
    const before = await rowState('copy');
    check('「复制」行有重命名按钮', before?.hasRename === true, JSON.stringify(before));
    check('默认名为「复制」', before?.name === '复制', before?.name);
    console.log('');

    // ── 2. 改名落盘并同步到调色板 ───────────────────────────────────
    console.log('【2】改名写进 specialActions，并同步到上方调色板');
    pendingPrompt = '一键复制';
    await page.locator('.source-row.special-action-row[data-action-id="copy"] button[title="重命名按钮"]').click();
    await page.waitForTimeout(300);
    const renamed = await readStorage(['specialActions']);
    check('返回的是 prompt 对话框', lastDialog.type === 'prompt', String(lastDialog.type));
    check('specialActions.copy.name 落盘', renamed.specialActions?.copy?.name === '一键复制', JSON.stringify(renamed.specialActions));
    const afterRename = await rowState('copy');
    check('行内名字跟着改', afterRename?.name === '一键复制', afterRename?.name);
    check('调色板里的名字也跟着改', (afterRename?.paletteName || []).includes('一键复制'), JSON.stringify(afterRename?.paletteName));
    console.log('');

    // ── 3. 停用：行内复选框 + 存储 ─────────────────────────────────
    console.log('【3】取消勾选「启用」，状态落盘且仍留在分组里');
    await page.locator('.source-row.special-action-row[data-action-id="copy"] .check').click();
    await page.waitForTimeout(300);
    const disabled = await readStorage(['specialActions', 'groups']);
    check('specialActions.copy.enabled 落盘为 false', disabled.specialActions?.copy?.enabled === false, JSON.stringify(disabled.specialActions));
    const stillListed = (disabled.groups || []).some((group) => (group.items || []).includes('action:copy'));
    check('停用后按钮仍留在分组配置里', stillListed === true, JSON.stringify(disabled.groups));
    const afterDisable = await rowState('copy');
    check('行内复选框显示为未勾选', afterDisable?.enabledChecked === false);
    check('停用后行仍在列表里（可再打开）', afterDisable !== null);
    console.log('');

    // ── 4. 停用后浮层不再画它 ─────────────────────────────────────
    console.log('【4】停用后页面浮层不再出现该按钮，重新启用后回来');
    const page2 = await env.context.newPage();
    await page2.goto(await env.serve(PAGE));
    await page2.waitForTimeout(1200);
    const selectText = async () => page2.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await selectText();
    await page2.waitForTimeout(350);
    await page2.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await page2.waitForTimeout(300);

    const panelNames = () => page2.evaluate((selector) => Array.from(
      document.querySelector(selector)?.shadowRoot?.querySelectorAll('.engine-list .engine .engine-name') || [],
    ).map((node) => node.textContent.trim()), PANEL_HOST);

    const disabledNames = await panelNames();
    check('停用的「一键复制」不在浮层里', !disabledNames.includes('一键复制'), JSON.stringify(disabledNames));
    check('同一分组里的「问 ai」仍在浮层里', disabledNames.includes('问 ai'), JSON.stringify(disabledNames));

    // 重新启用：页面侧监听 specialActions，浮层应即时补回来。
    await page.locator('.source-row.special-action-row[data-action-id="copy"] .check').click();
    await page2.waitForTimeout(500);
    const enabledNames = await panelNames();
    check('重新启用后浮层即时出现「一键复制」', enabledNames.includes('一键复制'), JSON.stringify(enabledNames));
    const renamedTitle = await page2.evaluate((selector) => document.querySelector(selector)
      ?.shadowRoot?.querySelector('.engine.special-copy')?.getAttribute('title') || '', PANEL_HOST);
    check('改名后悬浮提示用新名字（仅图标时也能看到）', renamedTitle === '一键复制', renamedTitle);
    await page2.close();
    console.log('');

    // ── 5. 清空名字回到默认名 ───────────────────────────────────────
    console.log('【5】清空名字后回到动作默认名');
    pendingPrompt = '';
    await page.locator('.source-row.special-action-row[data-action-id="copy"] button[title="重命名按钮"]').click();
    await page.waitForTimeout(300);
    const cleared = await readStorage(['specialActions']);
    check('specialActions 里不再保留 name', cleared.specialActions?.copy?.name === undefined, JSON.stringify(cleared.specialActions));
    const afterClear = await rowState('copy');
    check('行内回到「复制」', afterClear?.name === '复制', afterClear?.name);
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });