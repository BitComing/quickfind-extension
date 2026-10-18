// 一次性验证脚本（用完即删）：
//   1) 全新 profile 加载构建产物 → 打开选项页 → 读回 storage，与「改动前浏览器里那套配置」逐项比对
//   2) 常驻搜索栏：空框展开不抢焦点 / 有内容展开同样不聚焦
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, EXT, resolveChrome } = require('./helpers.cjs');
const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const HOST = '#quickfind-pinned-search-host';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

// 改动前那套浏览器配置（从 Edge 的扩展存储里回放出来的），只作比对基准。
const EXPECTED = fs.readFileSync(path.join(__dirname, 'fixtures', '_sync-state.txt'), 'utf8')
  .split('\n\n').filter((block) => block.startsWith('KEY')).reduce((acc, block) => {
    const key = block.match(/^KEY\(\d+\) "(.*)"$/m)[1];
    const value = block.match(/^VAL\(\d+\) ([\s\S]*)$/m)[1];
    acc[key] = JSON.parse(value);
    return acc;
  }, {});

// 把两侧都压成同一形状：分组 id 在默认值里是语义名、在浏览器里是时间戳，用组名做归一；
// 分组数组顺序不参与比较（可见顺序由默认组的 items 决定，单独断言）。
function canonical(cfg) {
  const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  const nameById = new Map(groups.map((group) => [String(group.id), String(group.name)]));
  const resolve = (token) => token.startsWith('group:') ? 'group:' + (nameById.get(token.slice(6)) ?? token.slice(6)) : token;
  const groupMap = {};
  groups.forEach((group) => { groupMap[String(group.name)] = (group.items || []).map(resolve); });
  return {
    scalars: {
      enabled: cfg.enabled === true,
      triggerMode: cfg.triggerMode,
      editableTriggerMode: cfg.editableTriggerMode,
      defaultGroupCount: cfg.defaultGroupCount,
      selectionTriggerDelay: cfg.selectionTriggerDelay,
      llmDockVisible: cfg.llmDockVisible,
      llm: { enabled: cfg.llm && cfg.llm.enabled, endpoint: cfg.llm && cfg.llm.endpoint, model: cfg.llm && cfg.llm.model, apiKey: cfg.llm && cfg.llm.apiKey, systemPrompt: cfg.llm && cfg.llm.systemPrompt },
      sourceConfigVersion: cfg.sourceConfigVersion,
    },
    sources: (cfg.sources || []).map((s) => ({ id: s.id, name: s.name, mark: s.mark, detail: s.detail, url: s.url, className: s.className, enabled: s.enabled !== false, iconOnly: s.iconOnly === true })),
    groups: groupMap,
    defaultItems: groups.find((group) => group.id === 'default') ? groups.find((group) => group.id === 'default').items.map(resolve) : null,
    groupNames: groups.map((group) => String(group.name)).sort(),
    pinnedSearch: {
      allSites: cfg.pinnedSearch && cfg.pinnedSearch.allSites === true,
      collapseDelay: cfg.pinnedSearch && cfg.pinnedSearch.collapseDelay,
      defaultGroupCount: cfg.pinnedSearch && cfg.pinnedSearch.defaultGroupCount,
      openInNewTab: cfg.pinnedSearch && cfg.pinnedSearch.openInNewTab === true,
      siteConfigVersion: cfg.pinnedSearch && cfg.pinnedSearch.siteConfigVersion,
      sites: (cfg.pinnedSearch && cfg.pinnedSearch.sites) || [],
      customSites: (cfg.pinnedSearch && cfg.pinnedSearch.customSites) || [],
    },
  };
}

function diff(expected, actual, label, out = []) {
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push(`${label}: 期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`);
    return out;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) diff(expected[key], actual[key], label ? `${label}.${key}` : key, out);
  return out;
}

async function pinnedState(page) {
  return page.evaluate((hostSelector) => {
    const host = document.querySelector(hostSelector);
    const root = host && host.shadowRoot;
    const input = root && root.querySelector('.pinned-query');
    return {
      exists: Boolean(host),
      hidden: host ? host.hidden : null,
      collapsed: host ? host.classList.contains('is-collapsed') : null,
      entries: root ? root.querySelectorAll('.entries .entry').length : 0,
      query: input ? input.value : null,
      shadowActive: root ? (root.activeElement ? root.activeElement.className : null) : null,
      documentActive: document.activeElement ? document.activeElement.tagName : null,
      caret: input ? input.selectionStart : null,
      caretEnd: input ? input.value.length : null,
    };
  }, HOST);
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>qf verify</title><body style="font:16px sans-serif"><p id="text">QuickFind 常驻栏验证页面，用来提供一段可读文本。</p></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-verify-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  console.log(`扩展已加载：${extId}，profile：${userDataDir}\n`);

  // ---------- 1. 默认配置 ----------
  console.log('【1】全新安装的默认配置 vs 改动前的浏览器配置');
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await optionsPage.waitForTimeout(1000);
  const stored = await optionsPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.get(null, resolve)));

  const differences = diff(canonical(EXPECTED), canonical(stored), '');
  if (differences.length === 0) {
    console.log('  PASS  45 项默认配置与改动前完全一致');
  } else {
    failures += 1;
    console.log(`  FAIL  ${differences.length} 项与改动前不一致：`);
    for (const item of differences) console.log('        ' + item);
  }
  check('搜索历史不随默认值带过来', stored.searchHistory === undefined || (Array.isArray(stored.searchHistory) && stored.searchHistory.length === 0), JSON.stringify(stored.searchHistory));
  console.log(`  实际的分组名与可见顺序：${JSON.stringify(canonical(stored).groupNames)} / 默认组 ${JSON.stringify(canonical(stored).defaultItems)}`);
  console.log(`  实际默认组里只显示图标的源：${JSON.stringify((stored.sources || []).filter((s) => s.iconOnly === true).map((s) => s.id))}\n`);

  console.log('【1b】选项页上呈现的默认值');
  const ui = await optionsPage.evaluate(() => ({
    triggerMode: document.querySelector('input[name="trigger-mode"]:checked')?.value ?? null,
    editableTriggerMode: document.querySelector('input[name="editable-trigger-mode"]:checked')?.value ?? null,
    llmDockVisible: document.querySelector('#llm-dock-visible')?.checked ?? null,
    llmEnabled: document.querySelector('#llm-enabled')?.checked ?? null,
    pinnedAllSites: document.querySelector('#pinned-all-sites')?.checked ?? null,
    pinnedCollapseDelay: document.querySelector('#pinned-collapse-delay')?.value ?? null,
    defaultGroupCount: document.querySelector('#default-group-count')?.value ?? null,
    pinnedDefaultGroupCount: document.querySelector('#pinned-default-group-count')?.value ?? null,
    selectedSourceCount: document.querySelectorAll('#source-list input[type="checkbox"]:checked').length,
    groupNames: Array.from(document.querySelectorAll('#group-list .group-name, #group-list strong, #group-list .group-title')).map((node) => node.textContent.trim()),
  }));
  check('网页选中文字触发方式 = 点击', ui.triggerMode === 'click', ui.triggerMode);
  check('编辑框选中文字触发方式 = 不显示', ui.editableTriggerMode === 'none', ui.editableTriggerMode);
  check('「随心问」面板开关 = 关', ui.llmDockVisible === false, String(ui.llmDockVisible));
  check('LLM 启用开关 = 关', ui.llmEnabled === false, String(ui.llmEnabled));
  check('常驻栏「所有站点」开关 = 开', ui.pinnedAllSites === true, String(ui.pinnedAllSites));
  check('常驻栏收起延时 = 1000', ui.pinnedCollapseDelay === '1000', ui.pinnedCollapseDelay);
  check('选区默认分组展示数量 = 4', ui.defaultGroupCount === '4', ui.defaultGroupCount);
  check('常驻栏默认分组展示数量 = 4', ui.pinnedDefaultGroupCount === '4', ui.pinnedDefaultGroupCount);
  console.log(`  选项页分组行文本：${JSON.stringify(ui.groupNames)}`);
  console.log('');

  // ---------- 2a. 空框不抢焦点 ----------
  console.log('【2a】常驻搜索框为空时，展开不抢焦点');
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(HOST, { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(600);
  let state = await pinnedState(page);
  check('常驻栏已挂载且有条目', state.exists && state.entries > 0, JSON.stringify(state));
  check('新页面上常驻栏默认收起', state.collapsed === true, `collapsed=${state.collapsed}`);
  check('空框判定成立', state.query === '', `query=${JSON.stringify(state.query)}`);

  await page.locator(`${HOST} .reveal-handle`).dispatchEvent('click');
  await page.waitForTimeout(250);
  state = await pinnedState(page);
  check('展开成功', state.collapsed === false, `collapsed=${state.collapsed}`);
  check('焦点没有被拽进空的搜索框', state.shadowActive === null, `shadowRoot.activeElement=${state.shadowActive}`);

  // ---------- 2b. 有内容时展开同样不聚焦 ----------
  console.log('\n【2b】常驻搜索框有内容时，展开也不聚焦');
  await worker.evaluate((data) => new Promise((resolve) => chrome.storage.sync.set(data, resolve)), { searchHistory: [{ query: '绿电炼铝', timestamp: Date.now() }] });
  await page.waitForTimeout(400);
  await page.locator(`${HOST} .collapse-button`).dispatchEvent('click');
  await page.waitForTimeout(350);
  state = await pinnedState(page);
  check('已收起', state.collapsed === true, `collapsed=${state.collapsed}`);
  check('兜底值填进搜索框', state.query === '绿电炼铝', `query=${JSON.stringify(state.query)}`);

  await page.locator(`${HOST} .reveal-handle`).dispatchEvent('click');
  await page.waitForTimeout(250);
  state = await pinnedState(page);
  check('展开成功', state.collapsed === false, `collapsed=${state.collapsed}`);
  check('焦点没有被拽进搜索框', state.shadowActive !== 'pinned-query', `shadowRoot.activeElement=${state.shadowActive}`);
  check('已有内容保持不动', state.query === '绿电炼铝', `query=${JSON.stringify(state.query)}`);

  // ---------- 3. 老配置不被默认值覆盖 ----------
  console.log('\n【3】旧版安装（engines/iconOnly，没有 sources）不被默认值覆盖');
  await worker.evaluate(() => new Promise((resolve) => chrome.storage.sync.clear(resolve)));
  await worker.evaluate((data) => new Promise((resolve) => chrome.storage.sync.set(data, resolve)), {
    engines: { google: false },
    iconOnly: { bing: true },
    engineOrder: ['bing', 'google', 'zhihu'],
    sourceConfigVersion: 0,
  });
  const legacyPage = await context.newPage();
  await legacyPage.goto(`chrome-extension://${extId}/options.html`);
  await legacyPage.waitForTimeout(900);
  const migrated = await legacyPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.get(null, resolve)));
  const sourceById = new Map((migrated.sources || []).map((source) => [source.id, source]));
  const defaultGroup = (migrated.groups || []).find((group) => group.id === 'default') || {};
  check('旧版 engines 里关掉的源保持关闭', sourceById.get('google') && sourceById.get('google').enabled === false, JSON.stringify(sourceById.get('google')));
  check('旧版 iconOnly 里开启的源保持只显示图标', sourceById.get('bing') && sourceById.get('bing').iconOnly === true, JSON.stringify(sourceById.get('bing')));
  check('旧版 engineOrder 的顺序保留', JSON.stringify((defaultGroup.items || []).slice(0, 3)) === JSON.stringify(['bing', 'google', 'zhihu']), JSON.stringify((defaultGroup.items || []).slice(0, 3)));
  check('旧版键已清理', migrated.engines === undefined && migrated.iconOnly === undefined, JSON.stringify({ engines: migrated.engines, iconOnly: migrated.iconOnly }));
  check('没有把 4 个默认分组灌进旧版安装', !(migrated.groups || []).some((group) => ['其他', '视频', '社媒', 'ai'].includes(String(group.name))), JSON.stringify((migrated.groups || []).map((group) => group.name)));

  await context.close();
  server.close();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(2); });

