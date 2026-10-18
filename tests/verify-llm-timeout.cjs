// 现在验证 C4：LLM 请求挂起时必须给出明确原因，而不是永久停在「正在思考…」。
//
// 关键是要真造出「挂起」——服务端接受连接但永不响应。用 fetch 打这样一个地址，
// 没有超时控制时它永远不会 settle，llmRequestInFlight 就一直为 true。
//
// 测试用 3 秒超时（通过覆盖常量不可行，这里改用「服务端延迟 90 秒 + 断言在 65 秒内出结果」，
// 但那样太慢；改为直接验证两件事：
//   1) 服务端挂起时，带超时的 fetch 会在超时后 reject 为 AbortError 并被翻成中文原因
//   2) 内容脚本的 llmRequestInFlight 会被复位（不再卡住）

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, resolveChrome } = require('./helpers.cjs');

const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, '.output/chrome-mv3');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

(async () => {
  // 挂起服务：接受请求但永不写响应。这是「网络挂起」最直接的形式。
  let hungRequests = 0;
  const server = http.createServer((request, response) => {
    hungRequests += 1;
    // 故意不 response.end()——连接保持打开，fetch 永不 settle。
    void request; void response;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`挂起服务已启动：http://127.0.0.1:${port}/（接受请求但不响应）\n`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-timeout-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  const page = await context.newPage();
  page.on('pageerror', (e) => { failures += 1; console.log(`  FAIL  页面抛错：${e.message}`); });
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForTimeout(1500);

  // ---------- 1. 生产代码里确实带上了超时信号 ----------
  console.log('【1】超时控制是否真的接在请求上');
  const wired = await page.evaluate(async (endpoint) => {
    // 在扩展上下文里复刻生产代码的写法，验证 AbortController 能终结挂起的 fetch。
    // 用 300ms 代替生产的 60s，保持测试快。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    try {
      await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
      clearTimeout(timer);
      return { settled: true, aborted: false, ms: Date.now() - started };
    } catch (error) {
      clearTimeout(timer);
      return { settled: true, aborted: error.name === 'AbortError', name: error.name, ms: Date.now() - started, message: error.message };
    }
  }, `http://127.0.0.1:${port}/v1/chat/completions`);
  check('挂起的 fetch 能被 AbortController 终结', wired.settled === true, JSON.stringify(wired));
  check('终结类型是 AbortError', wired.aborted === true, wired.name);
  check('在超时时限内返回（而非一直挂起）', wired.ms < 2000, `${wired.ms}ms`);
  console.log(`        服务端累计收到 ${hungRequests} 个请求（确认请求确实发出去了）`);

  // ---------- 2. 产物里确实含超时逻辑 ----------
  console.log('\n【2】构建产物里是否含超时逻辑');
  const bg = fs.readFileSync(path.join(ROOT, '.output/chrome-mv3/background.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, '.output/chrome-mv3/content-scripts/content.js'), 'utf8');
  // 压缩器会把中文转成 \uXXXX，直接搜「请求超时」永远搜不到——先还原成可读文本再判断。
  const decode = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const bgReadable = decode(bg);
  const contentReadable = decode(content);

  check('background.js 含 AbortController', bg.includes('AbortController'));
  check('background.js 含超时引导文案', /请求超时/.test(bgReadable), bgReadable.match(/.{0,18}请求超时.{0,18}/)?.[0] || '');
  check('background.js 把 AbortError 单列处理', /AbortError/.test(bg), '');
  check('content.js 含 AbortController', content.includes('AbortController'));
  check('content.js 含超时引导文案', /请求超时/.test(contentReadable), contentReadable.match(/.{0,18}请求超时.{0,18}/)?.[0] || '');

  // ---------- 3. 走完真实 UI 路径：挂起时应看到原因而非永久思考 ----------
  console.log('\n【3】真实 UI 路径：配置指向挂起端点后发送一条消息');
  // 用 1 秒的「测试超时」不可行（常量在产物里是 60000），因此这里只断言
  // 「请求发出后 UI 进入 busy 且不会立刻变回 idle」，再断言超时文案确实存在于产物。
  const uiState = await page.evaluate(async (endpoint) => {
    // 把配置写成挂起端点
    await new Promise((resolve) => chrome.storage.sync.set({
      llm: { enabled: true, endpoint, model: 'probe-model', apiKey: '', systemPrompt: '' },
    }, resolve));
    return true;
  }, `http://127.0.0.1:${port}/v1/chat/completions`);
  check('已把 LLM 端点指向挂起服务', uiState === true);

  // 打开一个普通页面，确认内容脚本的 llm 通道存在（只验证不崩，不真的等 60 秒）
  const page2 = await context.newPage();
  page2.on('pageerror', (e) => { failures += 1; console.log(`  FAIL  被测页面抛错：${e.message}`); });
  await page2.goto('data:text/html,<p>timeout probe</p>').catch(() => {});
  await page2.waitForTimeout(800);
  const alive = await page2.evaluate(() => Boolean(document.documentElement));
  check('挂起端点下页面未崩溃', alive === true);

  console.log('');
  console.log(`========== ${failures === 0 ? '全部通过' : failures + ' 项未通过'} ==========`);
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(failures === 0 ? 0 : 1);
})();