// 设置里的语言切换支持英文（2026-11-07 需求）。
//
// 需求原文：「设置中，语言设置新增支持英文」。
// 这里验证的是一条完整链路：选项页切到 English 后落盘到 sync.language，
// 选项页 / 弹窗 / 页面浮层与常驻栏 / 对话窗口都跟着换文案；切回中文同样即时生效。

const { launchWithExtension, createChecker, waitExtensionReady } = require('./helpers.cjs');

const { check, summary } = createChecker();
const PANEL_HOST = '#quickfind-shadow-host';

const PAGE = '<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">'
  + '<p id="text" style="width:460px;line-height:2">This paragraph exists to produce a selection for the language test.</p></body>';

/** 分组名用英文，避免把用户数据里的中文误判成漏译；预设组「视频」与默认组名会随语言翻译。 */
const GROUPS = [
  { id: 'default', name: '默认组', items: ['xiaohongshu', 'bing', 'action:copy', 'action:ask-ai', 'group:group-video'], visible: true },
  { id: 'group-video', name: '视频', items: ['douyin'], visible: true },
];

const CJK = /[\u4e00-\u9fa5]/;

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    const readStorage = (keys) => page.evaluate((list) => new Promise((resolve) => chrome.storage.sync.get(list, resolve)), keys);
    const writeStorage = (value) => page.evaluate((payload) => new Promise((resolve) => chrome.storage.sync.set(payload, resolve)), value);

    await writeStorage({ groups: GROUPS });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.nav-item[data-panel="sources"]'));

    /** 侧栏 + 当前面板里看得见的文字（hidden 的面板与弹窗不算）。 */
    const visibleText = () => page.evaluate(() => {
      // 图标角标（红 / 复 / 知…）是源自己的 mark，语言名称本身就是「简体中文」，
      // 两者都不是界面文案，从检查范围里摘掉。
      const clone = document.querySelector('.settings-sidebar')?.cloneNode(true);
      const parts = [clone?.innerText || ''];
      document.querySelectorAll('.settings-panel.active').forEach((panel) => {
        const copy = panel.cloneNode(true);
        copy.querySelectorAll('.source-logo, .segmented').forEach((node) => node.remove());
        parts.push(copy.innerText || '');
      });
      return parts.join('\n');
    });
    const openPanel = async (name) => {
      await page.click(`.nav-item[data-panel="${name}"]`);
      await page.waitForTimeout(250);
    };

    // ── 1. 默认中文 ─────────────────────────────────────────────────
    console.log('【1】默认仍是中文');
    check('html lang 为 zh-CN', await page.evaluate(() => document.documentElement.lang) === 'zh-CN');
    check('导航是中文', (await page.textContent('.nav-item[data-panel="common"] span'))?.trim() === '常用设置');

    // ── 2. 在设置里切到 English，立即生效并落盘 ─────────────────────
    console.log('【2】语言设置切到 English：立即生效并写进存储');
    const languageRow = await page.evaluate(() => ({
      label: Array.from(document.querySelectorAll('.row-title')).map((node) => node.textContent.trim()),
      options: Array.from(document.querySelectorAll('input[name="language"]')).map((input) => input.value),
    }));
    check('常用设置里有「语言」一行', languageRow.label.includes('语言'), JSON.stringify(languageRow.label));
    check('可选简体中文与 English', languageRow.options.join(',') === 'zh-CN,en', JSON.stringify(languageRow.options));

    await page.evaluate(() => document.querySelector('input[name="language"][value="en"]').click());
    await page.waitForTimeout(400);
    const saved = await readStorage(['language']);
    check('language 落盘为 en', saved.language === 'en', String(saved.language));
    check('html lang 立即变成 en', await page.evaluate(() => document.documentElement.lang) === 'en');
    check('页面标题翻译为英文', await page.title() === 'QuickFind Settings', await page.title());
    check('导航立即翻译', (await page.textContent('.nav-item[data-panel="common"] span'))?.trim() === 'General');
    check('常用设置整页没有残留中文', !CJK.test(await visibleText()), (await visibleText()).slice(0, 300));

    // ── 3. 各设置页的英文文案 ─────────────────────────────────────
    console.log('【3】搜索源 / LLM / 历史 / 关于都切成英文');
    await openPanel('sources');
    const sourcesView = await page.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll('.group-tab')).map((node) => node.textContent.trim()),
      rows: Array.from(document.querySelectorAll('.source-row .source-meta strong')).map((node) => node.textContent.trim()),
      caption: document.querySelector('.list-head-caption')?.textContent?.trim() || '',
    }));
    check('分组标签翻译（默认组 / 视频）', sourcesView.tabs.join(',') === 'Default group,Video', JSON.stringify(sourcesView.tabs));
    check('内置源名翻译（小红书）', sourcesView.rows.includes('Xiaohongshu'), JSON.stringify(sourcesView.rows));
    check('特殊按钮名翻译（复制 / 问 ai）', sourcesView.rows.includes('Copy') && sourcesView.rows.includes('Ask AI'), JSON.stringify(sourcesView.rows));
    check('列表头文案翻译', sourcesView.caption === 'Icon only · Enabled', sourcesView.caption);
    check('搜索源页没有残留中文', !CJK.test(await visibleText()), (await visibleText()).slice(0, 300));

    await openPanel('llm');
    const llmText = await visibleText();
    check('LLM 页翻译', llmText.includes('API endpoint') && llmText.includes('System prompt'), llmText.slice(0, 200));
    check('LLM 页没有残留中文', !CJK.test(llmText), llmText.slice(0, 300));

    await openPanel('history');
    check('历史页空态翻译', (await visibleText()).includes('No search history yet'));
    check('历史页没有残留中文', !CJK.test(await visibleText()), (await visibleText()).slice(0, 200));

    await openPanel('about');
    // 付费功能已下线（`shared/license.ts` 的 PAID_FEATURES_ENABLED），「关于」页只剩版本：
    // 这里改为核对那一栏确实跟着语言翻过来，并顺手确认切语言不会让付费区块冒出来。
    const about = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel-content="about"]');
      return {
        text: panel?.innerText || '',
        headings: Array.from(panel?.querySelectorAll('.setting-block h3') || []).filter((node) => node.offsetParent !== null).map((node) => node.textContent.trim()),
        paidHidden: Array.from(panel?.querySelectorAll('[data-paid]') || []).every((node) => getComputedStyle(node).display === 'none'),
      };
    });
    check('关于页只剩版本一栏', about.headings.join(',') === 'Version', JSON.stringify(about.headings));
    check('关于页付费区块仍然隐藏', about.paidHidden === true, String(about.paidHidden));
    check('关于页没有残留中文', !CJK.test(about.text), about.text.slice(0, 300));

    // ── 4. 切回中文同样即时生效 ─────────────────────────────────────
    console.log('【4】切回简体中文：界面即时恢复');
    await openPanel('common');
    await page.evaluate(() => document.querySelector('input[name="language"][value="zh-CN"]').click());
    await page.waitForTimeout(400);
    check('language 落盘回 zh-CN', (await readStorage(['language'])).language === 'zh-CN');
    check('导航恢复中文', (await page.textContent('.nav-item[data-panel="common"] span'))?.trim() === '常用设置');
    check('标题恢复中文', (await page.title()) === 'QuickFind 设置', await page.title());
    // 再切回英文，供后面的弹窗 / 页面用例使用。
    await page.evaluate(() => document.querySelector('input[name="language"][value="en"]').click());
    await page.waitForTimeout(400);
    check('再次切换到英文', (await readStorage(['language'])).language === 'en');
    console.log('');

    // ── 5. 弹窗 ─────────────────────────────────────────────────────
    console.log('【5】弹窗跟随语言');
    const popup = await env.context.newPage();
    await popup.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup.waitForSelector('#engine-settings .engine-row');
    const popupView = await popup.evaluate(() => ({
      placeholder: document.querySelector('#query-input')?.placeholder || '',
      aria: document.querySelector('#query-input')?.getAttribute('aria-label') || '',
      tabs: Array.from(document.querySelectorAll('.group-tab')).map((node) => node.textContent.trim()),
      rows: Array.from(document.querySelectorAll('.engine-row strong')).map((node) => node.textContent.trim()),
      text: document.querySelector('.popup-shell')?.innerText || '',
      lang: document.documentElement.lang,
    }));
    check('弹窗 html lang 为 en', popupView.lang === 'en', popupView.lang);
    check('搜索框占位符翻译', popupView.placeholder === 'Type something to search', popupView.placeholder);
    check('搜索框 aria-label 翻译', popupView.aria === 'Search text', popupView.aria);
    check('弹窗分组标签翻译', popupView.tabs.join(',') === 'Default group,Video', JSON.stringify(popupView.tabs));
    check('弹窗源名翻译', popupView.rows.includes('Xiaohongshu') && popupView.rows.includes('Copy'), JSON.stringify(popupView.rows));
    // 图标角标（红 / 复 / 知…）是搜索源自己的 mark，属于用户数据，不算界面文案。
    check('弹窗界面文案没有残留中文', !CJK.test(popupView.tabs.join('') + popupView.placeholder), popupView.tabs.join(','));
    await popup.close();
    console.log('');

    // ── 6. 页面浮层 / 常驻栏 / 对话窗口 ─────────────────────────────
    console.log('【6】页面内的浮层、常驻栏、对话窗口跟随语言');
    const site = await env.context.newPage();
    await site.goto(await env.serve(PAGE));
    await waitExtensionReady(site);
    await site.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await site.waitForTimeout(350);
    await site.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await site.waitForTimeout(300);

    const panelView = () => site.evaluate((selector) => {
      const root = document.querySelector(selector)?.shadowRoot;
      return {
        triggerTitle: root?.querySelector('.quickfind-trigger')?.getAttribute('title') || '',
        queryAria: root?.querySelector('.query-input')?.getAttribute('aria-label') || '',
        names: Array.from(root?.querySelectorAll('.engine-list .engine .engine-name') || []).map((node) => node.textContent.trim()),
        panelText: root?.querySelector('.quickfind-panel')?.textContent || '',
        pinned: Array.from(document.querySelector('.quickfind-pinned-search-host, #quickfind-pinned-search-host')?.shadowRoot?.querySelectorAll('.entries .entry .name') || []).map((node) => node.textContent.trim()),
      };
    }, PANEL_HOST);

    const enPanel = await panelView();
    check('触发图标提示翻译', enPanel.triggerTitle === 'Search selected text', enPanel.triggerTitle);
    check('搜索输入框 aria-label 翻译', enPanel.queryAria === 'Edit search text', enPanel.queryAria);
    check('浮层源名翻译', enPanel.names.includes('Xiaohongshu'), JSON.stringify(enPanel.names));
    check('浮层特殊按钮翻译', enPanel.names.includes('Copy') && enPanel.names.includes('Ask AI'), JSON.stringify(enPanel.names));
    const enCopyTitle = await site.evaluate((selector) => document.querySelector(selector)
      ?.shadowRoot?.querySelector('.engine.special-copy')?.getAttribute('title') || '', PANEL_HOST);
    check('特殊按钮悬浮提示翻译', enCopyTitle === 'Copy search text', enCopyTitle);
    check('常驻栏源名翻译', enPanel.pinned.includes('Xiaohongshu'), JSON.stringify(enPanel.pinned));
    // 图标角标是用户数据（源自己的 mark），不在界面文案的检查范围里。
    check('浮层控件提示里没有残留中文', !CJK.test(enPanel.triggerTitle + enPanel.queryAria), enPanel.triggerTitle);

    // 对话窗口：点浮层里的「Ask AI」打开，模板里的静态文案与标题都要是英文。
    await site.locator(`${PANEL_HOST} .engine.special-ask-ai`).dispatchEvent('click');
    await site.waitForTimeout(400);
    const chat = await site.evaluate((selector) => {
      const dialog = document.querySelector(selector)?.shadowRoot?.querySelector('.llm-chat-dialog');
      if (!dialog) return null;
      return {
        title: dialog.querySelector('.llm-chat-title')?.textContent?.trim() || '',
        subtitle: dialog.querySelector('.llm-chat-subtitle')?.textContent?.trim() || '',
        footer: dialog.querySelector('.llm-chat-footer-note')?.textContent?.trim() || '',
        placeholder: dialog.querySelector('.llm-chat-input')?.placeholder || '',
        closeTitle: dialog.querySelector('.llm-chat-close')?.getAttribute('title') || '',
        text: dialog.innerText || '',
      };
    }, PANEL_HOST);
    check('对话窗口已打开', chat !== null);
    check('窗口副标题翻译', chat?.subtitle === 'gpt-4o-mini · chatting', chat?.subtitle);
    check('输入区说明翻译', chat?.footer === 'Answers come from the model you configured', chat?.footer);
    check('追问框占位符翻译', chat?.placeholder === 'Ask a follow-up…', chat?.placeholder);
    check('关闭按钮提示翻译', chat?.closeTitle === 'Close', chat?.closeTitle);
    check('对话窗口没有残留中文', !CJK.test(chat?.text || ''), (chat?.text || '').slice(0, 200));
    await site.evaluate((selector) => document.querySelector(selector)?.shadowRoot?.querySelector('.llm-chat-close')?.click(), PANEL_HOST);
    console.log('');

    // ── 7. 页面侧即时跟随语言变化 ───────────────────────────────────
    console.log('【7】页面打开着改语言，浮层与常驻栏即时切换');
    await writeStorage({ language: 'zh-CN' });
    await site.waitForTimeout(700);
    // 上一步点过「Ask AI」，浮层会随之收起；重新唤起再读列表。
    await site.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await site.waitForTimeout(350);
    await site.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await site.waitForTimeout(300);
    const zhPanel = await panelView();
    check('浮层源名即时切回中文', zhPanel.names.includes('小红书'), JSON.stringify(zhPanel.names));
    check('浮层特殊按钮即时切回中文', zhPanel.names.includes('复制') && zhPanel.names.includes('问 ai'), JSON.stringify(zhPanel.names));
    check('常驻栏即时切回中文', zhPanel.pinned.includes('小红书'), JSON.stringify(zhPanel.pinned));
    check('搜索框 aria-label 切回中文', zhPanel.queryAria === '编辑搜索内容', zhPanel.queryAria);
    await site.close();
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });