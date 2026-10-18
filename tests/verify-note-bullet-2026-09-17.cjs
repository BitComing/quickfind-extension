// 回归用例：无限大纲笔记与 Workflowy 对齐的圆点交互（保留，勿删）。
//   A) 结构清理：圆点是按钮；没有独立「专注」按钮 / 拖动把手 / 底部用法提示；输入框没有 placeholder
//   B) 输入框聚焦前后样式一致（不冒边框、不换背景、不加阴影）
//   C) 单击圆点进入专注
//   D) 长按圆点（>200ms）才进入拖动：出现浮层与投放指示，松手完成排序
//   E) 快速按住并移动不排序
//   F) 落点是自己后代时不允许
//   G) 选项页的大纲面板与页面侧栏一致
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, EXT, resolveChrome } = require('./helpers.cjs');
const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const PANEL_HOST = '#quickfind-shadow-host';
const HOLD_MS = 340;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SEED_SYNC = {
  enabled: true,
  sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
  groups: [{ id: 'default', name: '默认组', items: ['google'], visible: true }],
  sourceConfigVersion: 5,
  triggerMode: 'click',
  editableTriggerMode: 'none',
  defaultGroupCount: 20,
  selectionTriggerDelay: 0,
  llmDockVisible: true,
  searchHistory: [],
  pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: true, siteConfigVersion: 3 }
};

function seedNotes() {
  const now = Date.now();
  const node = (id, parentId, text, children = [], collapsed = false) => ({ id, parentId, children, text, collapsed, completed: false, createdAt: now, updatedAt: now });
  return {
    version: 2,
    rootId: 'root',
    updatedAt: now,
    nodes: {
      root: node('root', null, '', ['n-a', 'n-b', 'n-c']),
      'n-a': node('n-a', 'root', '第一项'),
      'n-b': node('n-b', 'root', '第二项', ['n-b1'], true),
      'n-b1': node('n-b1', 'n-b', '第二项的子项'),
      'n-c': node('n-c', 'root', '第三项')
    }
  };
}

async function readNotes(worker) {
  return worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get('quickfind-notes', (value) => resolve(value['quickfind-notes'] || null))));
}

function rootOrder(notes) {
  const root = notes && notes.nodes && notes.nodes.root;
  return root ? root.children.slice() : [];
}

const dockState = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector).shadowRoot;
  const rows = Array.from(root.querySelectorAll('.outline-list .note-row'));
  const inputs = Array.from(root.querySelectorAll('.outline-list .note-input'));
  const heading = root.querySelector('.notes-zoom-heading');
  return {
    rowIds: rows.map((row) => row.dataset.noteId),
    texts: inputs.map((input) => input.value),
    heading: heading ? heading.textContent : null,
    breadcrumb: root.querySelector('.outline-breadcrumb') ? root.querySelector('.outline-breadcrumb').textContent : null,
    ghost: Boolean(root.querySelector('.note-drag-ghost')),
    dragging: rows.filter((row) => row.classList.contains('dragging')).map((row) => row.dataset.noteId),
    indicators: rows.filter((row) => /drag-target-/.test(row.className)).map((row) => row.dataset.noteId + ':' + row.className.replace(/^.*drag-target-(\w+).*$/, '$1'))
  };
}, PANEL_HOST);

const inputStyle = (page, scope, inputSelector) => page.evaluate(([scopeSelector, inputSel]) => {
  const host = scopeSelector ? document.querySelector(scopeSelector) : null;
  const root = host && host.shadowRoot ? host.shadowRoot : document;
  const input = root.querySelector(inputSel);
  const style = getComputedStyle(input);
  return { border: style.borderTopWidth + ' ' + style.borderTopColor, shadow: style.boxShadow, background: style.backgroundColor };
}, [scope, inputSelector]);

async function longPress(page, from, to, holdMs = HOLD_MS) {
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.85, { steps: 12 });
  await sleep(80);
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>qf bullet verify</title><body style="font:16px sans-serif"><p>空白测试页</p></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-bullet-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1180, height: 900 }
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  console.log(`扩展已加载：${extId}\n`);

  const setSync = (data) => worker.evaluate((payload) => new Promise((resolve) => chrome.storage.sync.set(payload, resolve)), data);
  const setLocal = (data) => worker.evaluate((payload) => new Promise((resolve) => chrome.storage.local.set(payload, resolve)), data);
  await setSync(SEED_SYNC);
  await setLocal({ 'quickfind-notes': seedNotes() });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
  await sleep(600);

  // 打开侧栏并切到大纲页
  await page.locator(`${PANEL_HOST} .llm-rail`).dispatchEvent('click');
  await sleep(400);
  await page.locator(`${PANEL_HOST} .llm-tab[data-tab="outline"]`).dispatchEvent('click');
  await page.waitForSelector(`${PANEL_HOST} .outline-list .note-row`, { timeout: 8000 });
  await sleep(300);

  // ---------- A. 结构清理 ----------
  console.log('【A】结构清理');
  const shape = await page.evaluate((selector) => {
    const root = document.querySelector(selector).shadowRoot;
    const bullets = Array.from(root.querySelectorAll('.outline-list .note-bullet'));
    const rows = Array.from(root.querySelectorAll('.outline-list .note-row'));
    const inputs = Array.from(root.querySelectorAll('.outline-list .note-input'));
    const first = root.querySelector('.note-bullet');
    return {
      bulletTags: bullets.map((bullet) => bullet.tagName),
      bulletLabel: first ? first.getAttribute('aria-label') : null,
      zoomButtons: root.querySelectorAll('.outline-list .note-zoom').length,
      dragHandles: root.querySelectorAll('.outline-list .note-drag').length,
      hint: Boolean(root.querySelector('.outline-hint')) || root.innerHTML.includes('Enter 新建同级'),
      placeholders: inputs.map((input) => input.placeholder),
      hasPlaceholderAttr: inputs.some((input) => input.hasAttribute('placeholder')),
      notDraggable: rows.every((row) => row.draggable !== true),
      rowCount: rows.length
    };
  }, PANEL_HOST);
  check('行数 = 3（第三项的子项被收起）', shape.rowCount === 3, String(shape.rowCount));
  check('圆点是 button', shape.bulletTags.every((tag) => tag === 'BUTTON'), shape.bulletTags.join(','));
  check('圆点带无障碍名称', shape.bulletLabel === '专注此项目', String(shape.bulletLabel));
  check('没有独立的「专注」按钮', shape.zoomButtons === 0, String(shape.zoomButtons));
  check('没有独立拖动把手', shape.dragHandles === 0, String(shape.dragHandles));
  check('没有底部用法提示', shape.hint === false, String(shape.hint));
  check('输入框没有 placeholder 文案', shape.placeholders.every((text) => text === '') && shape.hasPlaceholderAttr === false, JSON.stringify(shape.placeholders));
  check('行不再是 HTML5 draggable', shape.notDraggable === true, String(shape.notDraggable));

  // ---------- B. 聚焦不冒边框 ----------
  console.log('\n【B】输入框聚焦前后样式');
  const before = await inputStyle(page, PANEL_HOST, '.outline-list .note-input');
  const focused = await page.evaluate((selector) => {
    const root = document.querySelector(selector).shadowRoot;
    const input = root.querySelector('.outline-list .note-input');
    input.focus();
    return root.activeElement === input;
  }, PANEL_HOST);
  const after = await inputStyle(page, PANEL_HOST, '.outline-list .note-input');
  check('第一个输入框拿到了焦点', focused === true, String(focused));
  check('边框不变（且本身透明）', before.border === after.border && /rgba\(0, 0, 0, 0\)|transparent/.test(after.border), `${before.border} → ${after.border}`);
  check('阴影不变（且本身没有）', before.shadow === after.shadow && after.shadow === 'none', `${before.shadow} → ${after.shadow}`);
  check('背景不变（且本身透明）', before.background === after.background && after.background === 'rgba(0, 0, 0, 0)', `${before.background} → ${after.background}`);

  // ---------- C. 单击圆点进入专注 ----------
  console.log('\n【C】单击圆点进入专注');
  const bullet = (index) => page.locator(`${PANEL_HOST} .outline-list .note-row`).nth(index).locator('.note-bullet');
  await bullet(1).click();
  await sleep(350);
  let state = await dockState(page);
  check('进入「第二项」的专注视图', state.heading === '第二项', String(state.heading));
  check('列表只剩它的子项', state.rowIds.join(',') === 'n-b1', state.rowIds.join(','));
  check('没被误当成拖动（无浮层）', state.ghost === false, String(state.ghost));
  await page.locator(`${PANEL_HOST} [data-outline-action="home"]`).dispatchEvent('click');
  await sleep(300);
  state = await dockState(page);
  check('返回上级后回到三项', state.rowIds.join(',') === 'n-a,n-b,n-c', state.rowIds.join(','));

  // ---------- D. 长按圆点拖动 ----------
  console.log('\n【D】长按圆点拖动');
  const firstBullet = await bullet(0).boundingBox();
  const lastRow = await page.locator(`${PANEL_HOST} .outline-list .note-row`).nth(2).boundingBox();
  await longPress(page, firstBullet, lastRow);
  const during = await dockState(page);
  check('长按后出现跟随浮层', during.ghost === true, String(during.ghost));
  check('源行进入拖动态', during.dragging.join(',') === 'n-a', during.dragging.join(','));
  check('目标行出现投放指示（下方）', during.indicators.join(',') === 'n-c:after', during.indicators.join(','));
  await page.mouse.up();
  await sleep(800);
  state = await dockState(page);
  const notes = await readNotes(worker);
  check('松手后顺序变成 n-b,n-c,n-a', state.rowIds.join(',') === 'n-b,n-c,n-a', state.rowIds.join(','));
  check('落盘顺序一致', rootOrder(notes).join(',') === 'n-b,n-c,n-a', rootOrder(notes).join(','));
  check('浮层已清理', state.ghost === false, String(state.ghost));
  check('拖动结束后没有被误认为专注（没进 zoom）', state.heading === null, String(state.heading));

  // 拖回去，方便后面用
  await setLocal({ 'quickfind-notes': seedNotes() });
  await page.reload();
  await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
  await sleep(600);
  await page.locator(`${PANEL_HOST} .llm-rail`).dispatchEvent('click');
  await sleep(400);
  await page.locator(`${PANEL_HOST} .llm-tab[data-tab="outline"]`).dispatchEvent('click');
  await page.waitForSelector(`${PANEL_HOST} .outline-list .note-row`, { timeout: 8000 });
  await sleep(300);

  // ---------- E. 快速按住并移动不排序 ----------
  console.log('\n【E】快速按住并移动');
  const quickFrom = await bullet(0).boundingBox();
  const quickTo = await page.locator(`${PANEL_HOST} .outline-list .note-row`).nth(2).boundingBox();
  await page.mouse.move(quickFrom.x + quickFrom.width / 2, quickFrom.y + quickFrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(quickTo.x + quickTo.width / 2, quickTo.y + 4, { steps: 6 });
  await page.mouse.up();
  await sleep(600);
  state = await dockState(page);
  check('没有进入拖动（无浮层）', state.ghost === false, String(state.ghost));
  check('顺序保持不变', state.rowIds.join(',') === 'n-a,n-b,n-c', state.rowIds.join(','));

  // ---------- F. 不能落到自己的后代 ----------
  console.log('\n【F】落点是自己后代');
  await page.locator(`${PANEL_HOST} .outline-list .note-row`).nth(1).locator('.note-toggle').click();
  await sleep(300);
  state = await dockState(page);
  check('展开「第二项」后能看到子项', state.rowIds.join(',') === 'n-a,n-b,n-b1,n-c', state.rowIds.join(','));
  const parentBullet = await bullet(1).boundingBox();
  const childRow = await page.locator(`${PANEL_HOST} .outline-list .note-row`).nth(2).boundingBox();
  await longPress(page, parentBullet, childRow);
  const blocked = await dockState(page);
  check('按住后确实进入了拖动', blocked.ghost === true, String(blocked.ghost));
  check('后代行上不出现投放指示', blocked.indicators.length === 0, blocked.indicators.join(','));
  await page.mouse.up();
  await sleep(700);
  state = await dockState(page);
  check('松手后顺序不变', state.rowIds.join(',') === 'n-a,n-b,n-b1,n-c', state.rowIds.join(','));

  // ---------- G. 选项页 ----------
  console.log('\n【G】选项页的大纲面板');
  await setLocal({ 'quickfind-notes': seedNotes() });
  // 关掉测试页，免得两边的笔记状态互相覆盖。
  await page.close();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForTimeout(900);
  await options.locator('.nav-item[data-panel="notes"]').click();
  await options.waitForSelector('#notes-outline .note-row', { timeout: 8000 });
  await options.waitForTimeout(300);

  const optionShape = await options.evaluate(() => {
    const bullets = Array.from(document.querySelectorAll('#notes-outline .note-bullet'));
    const inputs = Array.from(document.querySelectorAll('#notes-outline .note-input'));
    const rows = Array.from(document.querySelectorAll('#notes-outline .note-row'));
    return {
      bulletTags: bullets.map((bullet) => bullet.tagName),
      bulletLabel: bullets[0] ? bullets[0].getAttribute('aria-label') : null,
      zoomButtons: document.querySelectorAll('#notes-outline .note-zoom').length,
      dragHandles: document.querySelectorAll('#notes-outline .note-drag').length,
      placeholders: inputs.map((input) => input.placeholder),
      hasPlaceholderAttr: inputs.some((input) => input.hasAttribute('placeholder')),
      notDraggable: rows.every((row) => row.draggable !== true),
      rowIds: rows.map((row) => row.dataset.noteId)
    };
  });
  check('选项页圆点也是 button', optionShape.bulletTags.every((tag) => tag === 'BUTTON'), optionShape.bulletTags.join(','));
  check('选项页圆点带无障碍名称', optionShape.bulletLabel === '专注此项目', String(optionShape.bulletLabel));
  check('选项页没有「专注」按钮与拖动把手', optionShape.zoomButtons === 0 && optionShape.dragHandles === 0, `${optionShape.zoomButtons}/${optionShape.dragHandles}`);
  check('选项页输入框没有 placeholder', optionShape.placeholders.every((text) => text === '') && optionShape.hasPlaceholderAttr === false, JSON.stringify(optionShape.placeholders));
  check('选项页行不再是 draggable', optionShape.notDraggable === true, String(optionShape.notDraggable));

  const optBefore = await inputStyle(options, null, '#notes-outline .note-input');
  const optFocus = await options.evaluate(() => {
    const input = document.querySelector('#notes-outline .note-input');
    input.focus();
    return document.activeElement === input;
  });
  const optAfter = await inputStyle(options, null, '#notes-outline .note-input');
  check('选项页聚焦到输入框', optFocus === true, String(optFocus));
  check('选项页聚焦不冒边框', optBefore.border === optAfter.border && optBefore.shadow === optAfter.shadow && optAfter.shadow === 'none', `${optBefore.border}/${optBefore.shadow} → ${optAfter.border}/${optAfter.shadow}`);

  await options.locator('#notes-outline .note-row').nth(1).locator('.note-bullet').click();
  await options.waitForTimeout(350);
  const optionZoom = await options.evaluate(() => {
    const heading = document.querySelector('#notes-outline .notes-zoom-heading');
    return { heading: heading ? heading.textContent : null, rows: Array.from(document.querySelectorAll('#notes-outline .note-row')).map((row) => row.dataset.noteId) };
  });
  check('选项页单击圆点进入专注', optionZoom.heading === '第二项' && optionZoom.rows.join(',') === 'n-b1', JSON.stringify(optionZoom));
  await options.locator('#notes-home').click();
  await options.waitForTimeout(300);

  const optFrom = await options.locator('#notes-outline .note-row').nth(0).locator('.note-bullet').boundingBox();
  const optTo = await options.locator('#notes-outline .note-row').nth(2).boundingBox();
  await longPress(options, optFrom, optTo);
  const optDuring = await options.evaluate(() => ({
    ghost: Boolean(document.querySelector('.note-drag-ghost')),
    indicators: Array.from(document.querySelectorAll('#notes-outline .note-row')).filter((row) => /drag-target-/.test(row.className)).map((row) => row.dataset.noteId)
  }));
  check('选项页长按后出现浮层与投放指示', optDuring.ghost === true && optDuring.indicators.join(',') === 'n-c', JSON.stringify(optDuring));
  await options.mouse.up();
  await options.waitForTimeout(900);
  const optOrder = await options.evaluate(() => Array.from(document.querySelectorAll('#notes-outline .note-row')).map((row) => row.dataset.noteId));
  check('选项页松手后完成排序', optOrder.join(',') === 'n-b,n-c,n-a', optOrder.join(','));
  const optionNotes = await readNotes(worker);
  check('选项页落盘一致', rootOrder(optionNotes).join(',') === 'n-b,n-c,n-a', rootOrder(optionNotes).join(','));

  await context.close();
  server.close();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(2); });
