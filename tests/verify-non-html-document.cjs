/**
 * 非 HTML 文档（XML 错误页 / SVG）里内容脚本必须不崩、也不该挂出浮层。
 *
 * 报障原文（浏览器控制台，页面是 https://static.deepseek.com/）：
 *   Uncaught (in promise) TypeError: Cannot set properties of undefined (setting 'cssText')
 *   content-scripts/content.js  ← 栈顶是 main
 *
 * 根因：该域名根路径返回的是对象存储的 `application/xml` 错误页
 * （`<Error><Code>AccessDenied</Code>…`）。这种文档里 `document.createElement('div')`
 * 造出来的是没有 HTML 接口的元素，`el.style` 是 undefined，于是内容脚本开头那句
 * `host.style.cssText = …` 直接抛 TypeError，整个脚本就地中止——用户在普通网页上
 * 感知不到，但一条红色未处理异常会留在每个打开过这类地址的标签页控制台上。
 *
 * 断言分三层：
 *   一、非 HTML 文档（XML、SVG）——不抛异常、不注入宿主；
 *   二、text/plain —— MIME 也不是 text/html，但浏览器把它渲染成 HTML 文档，
 *       正文可选、浮层必须照常出现（防止「按 MIME 判」那种过度收紧的修法）；
 *   三、普通 HTML 页 —— 基线，证明前面的 PASS 不是「插件整体不工作了」。
 *
 * 每一项都先断言前置条件（这份文档到底是不是非 HTML 文档、正文到底有没有被选中），
 * 免得断言在环境变化后变成恒真。
 *
 * 注意「不注入宿主」这一条本身抓不住回归：崩在 `host.style.cssText` 时宿主还没入文档，
 * 这条断言在修与没修时都为真。真正钉住问题的是「不抛异常」那两条——已实测过：
 * 去掉守卫后，【1】【2】的不抛异常立刻转红。
 */

const http = require('http');
const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PANEL_HOST = '#quickfind-shadow-host';
const { check, summary } = createChecker();

/** 原样复刻 static.deepseek.com 根路径的 403 正文（S3 风格 XML 错误文档）。 */
const XML_DENIED =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Error><Code>AccessDenied</Code>'
  + '<Message>Access Denied</Message><RequestId>000001A19D041DD7940EAA072CFBD01A</RequestId>'
  + '<HostId>Z9v+cC1sRnaWw6x0vi8pxxYA0YVnKxbYHUPAFpnxkX8sLV44u5b02Z+ailn2wCnR</HostId></Error>';

/** 直接打开一个 .svg 文件：同样是 XML 文档，且是常见的「点了别人发来的图」。 */
const SVG_DOC = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">'
  + '<rect width="240" height="120" fill="#eef6f1"/>'
  + '<text x="16" y="66" font-size="18" fill="#27493b">svg document</text></svg>';

const PLAIN_TEXT = '这是一份直接用浏览器打开的纯文本文件，正文应当仍然可以被选中并弹出浮层。\n';

const HTML_PAGE = '<!doctype html><meta charset="utf-8"><title>qf html control</title>'
  + '<body style="font:16px/1.9 sans-serif;margin:0;padding:24px">'
  + '<p id="p">这是一段普通网页里的正文，作为对照基线。</p></body>';

/** 起一个按路径给不同 Content-Type 的本地服务。 */
async function serveDocuments() {
  const routes = {
    '/denied': { status: 403, type: 'application/xml; charset=utf-8', body: XML_DENIED },
    '/pic.svg': { status: 200, type: 'image/svg+xml', body: SVG_DOC },
    '/notes.txt': { status: 200, type: 'text/plain; charset=utf-8', body: PLAIN_TEXT },
    '/page.html': { status: 200, type: 'text/html; charset=utf-8', body: HTML_PAGE },
  };
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url, 'http://127.0.0.1').pathname] || routes['/page.html'];
    response.writeHead(route.status, { 'Content-Type': route.type });
    response.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 打开一个地址，收集该页面期间抛出的未捕获异常与扩展打出的错误日志。 */
async function openPage(context, url) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    // 本地服务故意返回 403 的用例会带一条「Failed to load resource」，那是被测内容本身，不是脚本错误。
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) consoleErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  return { page, pageErrors, consoleErrors };
}

/** 读文档形状：这份文档到底能不能承载 HTML 元素、插件宿主管不管。 */
const readDocumentShape = (page) => page.evaluate((selector) => ({
  contentType: document.contentType,
  // 关键前置条件：XML/SVG 文档里这个元素没有 style，正是崩溃的直接来源。
  htmlElementsAvailable: Boolean(document.createElement('div').style),
  hostInjected: Boolean(document.querySelector(selector)),
}), PANEL_HOST);

/** 造选区并派发 mouseup（等同真实拖选的结束事件），再看触发图标。 */
async function selectParagraph(page, selector, length) {
  await page.evaluate(({ sel, len }) => {
    const element = document.querySelector(sel);
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(len, (element.textContent || '').length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 140, clientY: 140 }));
  }, { sel: selector, len: length });
  await page.waitForTimeout(600);
  return page.evaluate((hostSelector) => {
    const trigger = document.querySelector(hostSelector)?.shadowRoot?.querySelector('.quickfind-trigger');
    if (!trigger) return null;
    return { visible: trigger.classList.contains('visible'), opacity: Number.parseFloat(getComputedStyle(trigger).opacity) };
  }, PANEL_HOST);
}

(async () => {
  const docs = await serveDocuments();
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['google'], visible: true }],
      triggerMode: 'click', editableTriggerMode: 'click', selectionTriggerDelay: 0, defaultGroupCount: 20,
      searchHistory: [], llmDockVisible: false,
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
    }, resolve)));

    // ---------- 【1】XML 错误页：此前必崩 ----------
    console.log('【1】对象存储的 XML 错误页（application/xml）');
    {
      const { page, pageErrors, consoleErrors } = await openPage(env.context, `${docs.origin}/denied`);
      const shape = await readDocumentShape(page);
      check('这份文档确实是非 HTML 文档（前置条件）', shape.htmlElementsAvailable === false, JSON.stringify(shape));
      check('不再抛 cssText 的 TypeError（报障的那条）',
        pageErrors.length === 0 && consoleErrors.length === 0,
        [...pageErrors, ...consoleErrors].join(' | ') || '无');
      check('XML 文档里不注入浮层宿主', shape.hostInjected === false, JSON.stringify(shape));
      await page.close();
    }
    console.log('');

    // ---------- 【2】直接打开的 SVG：同一类文档 ----------
    console.log('【2】直接打开的 SVG（image/svg+xml）');
    {
      const { page, pageErrors } = await openPage(env.context, `${docs.origin}/pic.svg`);
      const shape = await readDocumentShape(page);
      check('这份文档确实没有 HTML 元素接口（前置条件）', shape.htmlElementsAvailable === false, JSON.stringify(shape));
      check('SVG 文档里不抛异常', pageErrors.length === 0, pageErrors.join(' | ') || '无');
      check('SVG 文档里不注入浮层宿主', shape.hostInjected === false, JSON.stringify(shape));
      await page.close();
    }
    console.log('');

    // ---------- 【3】text/plain：MIME 也不是 HTML，但必须照常工作 ----------
    console.log('【3】text/plain 纯文本页（不能一并误杀）');
    {
      const { page, pageErrors } = await openPage(env.context, `${docs.origin}/notes.txt`);
      const shape = await readDocumentShape(page);
      check('纯文本页在浏览器里是 HTML 文档（前置条件）', shape.htmlElementsAvailable === true, JSON.stringify(shape));
      check('纯文本页仍注入浮层宿主', shape.hostInjected === true, JSON.stringify(shape));
      check('纯文本页不抛异常', pageErrors.length === 0, pageErrors.join(' | ') || '无');
      await page.close();
    }
    console.log('');

    // ---------- 【4】普通 HTML 页：基线 ----------
    console.log('【4】普通 HTML 页（基线）');
    {
      const { page, pageErrors } = await openPage(env.context, `${docs.origin}/page.html`);
      const shape = await readDocumentShape(page);
      check('HTML 页仍注入浮层宿主', shape.hostInjected === true, JSON.stringify(shape));
      const trigger = await selectParagraph(page, '#p', 12);
      check('HTML 页选中文字仍出现触发图标（否定对照：不是「整个插件没跑」）',
        trigger !== null && trigger.visible === true && trigger.opacity > 0, JSON.stringify(trigger));
      check('HTML 页全程不抛异常', pageErrors.length === 0, pageErrors.join(' | ') || '无');
      await page.close();
    }

    return summary();
  } finally {
    await env.close();
    await docs.close();
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });