// 一次性验证脚本（用完即删）：特殊功能按钮「笔记」把内容存到无限大纲笔记的第一行。
//   0) 三个入口都出现这枚按钮（选中文字浮层 / 常驻搜索栏 / 弹窗）
//   A) 选中文字 → 点「记」→ 笔记第一行是选中内容，原有第一行被顶到第二行，页面不被跳走
//   B) 常驻搜索栏 → 点「记」→ 同上（内容取常驻框的值）
//   C) 弹窗 → 点「记」→ 页面没有内容脚本时写存储兜底 / 有内容脚本时交给它写
//   D) 选项页「特殊功能按钮」里能选分组，搜索源列表里能看到这枚按钮
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, EXT, resolveChrome } = require('./helpers.cjs');
const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const PANEL_HOST = '#quickfind-shadow-host';
const PINNED_HOST = '#quickfind-pinned-search-host';
const PARAGRAPH = '选中的这一段文字要进笔记第一行，后面还有别的字。';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 预置配置：默认组里放「复制」「笔记」两枚按钮，常驻栏对所有站点生效，侧栏可见。
const SEED_SYNC = {
  enabled: true,
  sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
  groups: [{ id: 'default', name: '默认组', items: ['google', 'action:copy', 'action:notes'], visible: true }],
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
  const root = { id: 'root', parentId: null, children: ['n-old'], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now };
  return {
    version: 2,
    rootId: 'root',
    nodes: {
      root,
      'n-old': { id: 'n-old', parentId: 'root', children: [], text: '旧的第一行', collapsed: false, completed: false, createdAt: now, updatedAt: now }
    },
    updatedAt: now
  };
}

async function readNotes(worker) {
  return worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get('quickfind-notes', (value) => resolve(value['quickfind-notes'] || null))));
}

function texts(notes) {
  const root = notes && notes.nodes && notes.nodes.root;
  return (root ? root.children : []).map((id) => (notes.nodes[id] ? notes.nodes[id].text : '<缺失 ' + id + '>'));
}

// 点整个页面里第一个「记」按钮所在的浮层列表项（按钮在 pointer-events:none 的宿主里，用 dispatchEvent 触发监听）。
async function dockState(page) {
  return page.evaluate((hostSelector) => {
    const root = document.querySelector(hostSelector).shadowRoot;
    const dock = root.querySelector('.llm-dock');
    const inputs = Array.from(root.querySelectorAll('.outline-list .note-input'));
    return {
      dockHidden: dock.hidden,
      dockOpen: dock.classList.contains('is-open'),
      activeTab: root.querySelector('.llm-tab.is-active') ? root.querySelector('.llm-tab.is-active').dataset.tab : null,
      outlineHidden: root.querySelector('.llm-pane[data-pane="outline"]').hidden,
      noteTexts: inputs.map((input) => input.value),
      focused: root.activeElement ? root.activeElement.className : null
    };
  }, PANEL_HOST);
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>qf notes verify</title>
<body style="font:16px sans-serif">
  <form onsubmit="return false"><input name="q" style="width:280px"><button>搜索</button></form>
  <p id="text" style="width:420px;line-height:1.9">${PARAGRAPH}</p>
</body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-notes-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 }
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  console.log(`扩展已加载：${extId}，profile：${userDataDir}\n`);

  const setSync = (data) => worker.evaluate((payload) => new Promise((resolve) => chrome.storage.sync.set(payload, resolve)), data);
  const setLocal = (data) => worker.evaluate((payload) => new Promise((resolve) => chrome.storage.local.set(payload, resolve)), data);
  await setSync(SEED_SYNC);
  await setLocal({ 'quickfind-notes': seedNotes() });

  // ---------- A. 选中文字浮层 ----------
  console.log('【A】选中文字 → 浮层里的「记」');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
  await page.waitForSelector(PINNED_HOST, { state: 'attached', timeout: 10000 });
  await sleep(700);

  const box = await page.locator('#text').boundingBox();
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + 8, { steps: 12 });
  await page.mouse.up();
  await sleep(300);

  const triggerVisible = await page.evaluate((hostSelector) => document.querySelector(hostSelector).shadowRoot.querySelector('.quickfind-trigger').classList.contains('visible'), PANEL_HOST);
  check('选中文字后出现搜索按钮', triggerVisible === true, String(triggerVisible));

  await page.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
  await sleep(250);
  const panel = await page.evaluate((hostSelector) => {
    const root = document.querySelector(hostSelector).shadowRoot;
    const notes = root.querySelector('.engine.special-notes');
    return {
      query: root.querySelector('.query-input').value,
      hasNotes: Boolean(notes),
      notesMark: notes ? notes.querySelector('.engine-mark').textContent : null,
      notesTitle: notes ? notes.title : null,
      marks: Array.from(root.querySelectorAll('.engine-list .engine')).map((button) => button.className.replace('engine ', ''))
    };
  }, PANEL_HOST);
  check('浮层里出现「记」按钮', panel.hasNotes === true, JSON.stringify(panel.marks));
  check('「记」按钮图标与提示正确', panel.notesMark === '记' && panel.notesTitle === '把内容存到笔记第一行', `${panel.notesMark} / ${panel.notesTitle}`);
  check('搜索框带上了选中文字', panel.query.length > 0 && PARAGRAPH.includes(panel.query), JSON.stringify(panel.query));

  const urlBefore = page.url();
  await page.locator(`${PANEL_HOST} .engine.special-notes`).dispatchEvent('click');
  await sleep(900);

  let notes = await readNotes(worker);
  check('笔记第一行 = 选中文字', texts(notes)[0] === panel.query, JSON.stringify(texts(notes)));
  check('原来的第一行被顶到第二行且没丢', texts(notes)[1] === '旧的第一行', JSON.stringify(texts(notes)));
  check('没有多写条目', texts(notes).length === 2, String(texts(notes).length));
  check('页面没有被跳走', page.url() === urlBefore, page.url());

  let dock = await dockState(page);
  check('侧栏自动切到大纲页并展开', dock.dockOpen === true && dock.activeTab === 'outline' && dock.outlineHidden === false, JSON.stringify(dock));
  check('大纲里第一项就是刚存的内容', dock.noteTexts[0] === panel.query, JSON.stringify(dock.noteTexts));

  // ---------- B. 常驻搜索栏 ----------
  console.log('\n【B】常驻搜索栏 → 「记」');
  await page.locator(`${PINNED_HOST} .reveal-handle`).dispatchEvent('click');
  await sleep(300);
  // 用真实键盘输入：常驻框在「用户正在编辑」时不该被选区自动填入覆盖。
  await page.evaluate((hostSelector) => { document.querySelector(hostSelector).shadowRoot.querySelector('.pinned-query').focus(); }, PINNED_HOST);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('常驻栏要存进去的内容');
  await sleep(300);
  const pinnedQuery = await page.evaluate((hostSelector) => document.querySelector(hostSelector).shadowRoot.querySelector('.pinned-query').value, PINNED_HOST);
  check('常驻框接受了用户输入', pinnedQuery === '常驻栏要存进去的内容', JSON.stringify(pinnedQuery));

  const pinnedHasNotes = await page.evaluate((hostSelector) => Boolean(document.querySelector(hostSelector).shadowRoot.querySelector('.entries .entry.special-notes')), PINNED_HOST);
  check('常驻栏里有「记」按钮', pinnedHasNotes === true);
  await page.locator(`${PINNED_HOST} .entries .entry.special-notes`).dispatchEvent('click');
  await sleep(900);

  notes = await readNotes(worker);
  check('笔记第一行 = 常驻框内容', texts(notes)[0] === '常驻栏要存进去的内容', JSON.stringify(texts(notes)));
  check('之前两条都在后面', texts(notes)[1] === panel.query && texts(notes)[2] === '旧的第一行', JSON.stringify(texts(notes)));

  // ---------- C. 弹窗 ----------
  console.log('\n【C】弹窗 → 「记」');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(800);

  const popupUi = await popup.evaluate(() => {
    const notesRow = document.querySelector('[title="把内容存到笔记第一行"]');
    return { hasNotes: Boolean(notesRow), logo: notesRow ? notesRow.querySelector('.engine-logo').className : null, rows: document.querySelectorAll('.engine-row').length };
  });
  check('弹窗里出现「记」按钮行', popupUi.hasNotes === true, JSON.stringify(popupUi));

  // C1：当前活动页就是弹窗自己（没有内容脚本）→ 走存储兜底
  await popup.bringToFront();
  await popup.fill('#query-input', '弹窗兜底写入的内容');
  await popup.evaluate(() => document.querySelector('[title="把内容存到笔记第一行"]').click());
  await sleep(700);
  notes = await readNotes(worker);
  check('兜底路径：笔记第一行 = 弹窗输入', texts(notes)[0] === '弹窗兜底写入的内容', JSON.stringify(texts(notes)));
  check('兜底路径：条目数 +1', texts(notes).length === 4, String(texts(notes).length));

  // C2：把测试页切到前台（它有内容脚本）→ 交给页面侧栏写，并展开侧栏
  await page.bringToFront();
  await sleep(200);
  await popup.fill('#query-input', '弹窗交给侧栏写入的内容');
  await popup.evaluate(() => document.querySelector('[title="把内容存到笔记第一行"]').click());
  await sleep(900);
  notes = await readNotes(worker);
  check('消息路径：笔记第一行 = 弹窗输入', texts(notes)[0] === '弹窗交给侧栏写入的内容', JSON.stringify(texts(notes)));
  check('消息路径：条目数 +1', texts(notes).length === 5, String(texts(notes).length));
  dock = await dockState(page);
  check('消息路径：页面侧栏被展开到大纲页', dock.dockOpen === true && dock.activeTab === 'outline', JSON.stringify(dock));

  // ---------- D. 选项页 ----------
  console.log('\n【D】选项页的「特殊功能按钮」');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForTimeout(1000);
  const optionUi = await options.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#special-action-list .special-action-config'));
    const notesRow = rows.find((row) => row.querySelector('.source-logo.special-notes'));
    return {
      count: rows.length,
      names: rows.map((row) => row.querySelector('.special-action-meta strong').textContent),
      noteDetail: notesRow ? notesRow.querySelector('.special-action-meta small').textContent : null,
      noteGroup: notesRow ? notesRow.querySelector('select').value : null,
      options: notesRow ? Array.from(notesRow.querySelectorAll('option')).map((option) => option.textContent) : [],
      listRow: Boolean(document.querySelector('#source-list .source-row[data-action-id="notes"]')),
      listRowDetail: document.querySelector('#source-list .source-row[data-action-id="notes"] .source-meta small') ? document.querySelector('#source-list .source-row[data-action-id="notes"] .source-meta small').textContent : null
    };
  });
  check('配置区里两枚按钮（复制 / 笔记）', optionUi.count === 2 && optionUi.names.includes('笔记'), JSON.stringify(optionUi.names));
  check('笔记行说明文案正确', optionUi.noteDetail === '存到无限大纲笔记第一行', String(optionUi.noteDetail));
  check('分组下拉已选中默认组', optionUi.noteGroup === 'default', String(optionUi.noteGroup));
  check('下拉里有「未添加」和分组可选', optionUi.options.includes('未添加') && optionUi.options.includes('默认组'), JSON.stringify(optionUi.options));
  check('搜索源列表里能看到这枚按钮', optionUi.listRow === true && optionUi.listRowDetail === '存到无限大纲笔记第一行', String(optionUi.listRowDetail));

  await context.close();
  server.close();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(2); });
