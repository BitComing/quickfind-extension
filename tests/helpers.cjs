/**
 * 回归测试的公共装置。
 *
 * 这一批用例原本是「一次性验证脚本」，路径全是硬编码的绝对路径（playwright 模块、
 * 项目根、Chromium 可执行文件），只在写它的那台机器上能跑。入库之后它要能在别人的
 * 机器和 CI 上跑，所以路径改成自动解析，并允许用环境变量覆盖：
 *
 *   QF_ROOT         项目根目录（默认取本文件的上两级）
 *   QF_PW           playwright 模块位置（默认先试项目依赖，再试已安装的 chrome-launcher 环境）
 *   QF_CHROME       Chromium 可执行文件（默认用 playwright 自带的，不写死版本号）
 *
 * 之所以不直接用 playwright 的 `chromium.launchPersistentContext` 默认浏览器：
 * 加载扩展需要 persistence + --load-extension，用自带 Chromium 最稳。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.QF_ROOT || path.resolve(__dirname, '..');
const EXT = path.join(ROOT, '.output/chrome-mv3');
/** 期望的 playwright 版本。别处已安装时版本要与它一致，否则行为可能不同。 */
const PW_RANGE = fs.existsSync(path.join(ROOT, 'package.json'))
  ? (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies || {}).playwright || '*'
  : '*';

/**
 * playwright 模块解析：优先项目依赖，其次 QF_PW 指定的路径，最后是 home 下的全局安装。
 *
 * 为什么不写死某一台的绝对路径：脚本要能被别人和 CI 跑。home 那份是「同机但装在项目外」
 * 的常见情形（本机就是如此），按用户目录推导而不是写死盘符。
 */
function resolvePlaywright() {
  const candidates = [
    process.env.QF_PW,
    path.join(ROOT, 'node_modules', 'playwright'),
    path.join(os.homedir(), 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch { /* 试下一个 */ }
  }
  throw new Error(
    `找不到 playwright（项目期望 ${PW_RANGE}）。两种做法：\n` +
    '  1) npm i -D playwright  然后  npx playwright install chromium\n' +
    '  2) 若已装在别处：QF_PW=<playwright 模块目录> npm run test:e2e\n' +
    '已尝试：' + candidates.join('、'),
  );
}

/** Chromium 可执行文件解析：环境变量 > playwright 自带（不写死版本号）。 */
function resolveChrome(chromium) {
  if (process.env.QF_CHROME && fs.existsSync(process.env.QF_CHROME)) return process.env.QF_CHROME;
  // playwright 的 chromium.executablePath() 会按当前安装的版本给出正确路径。
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* 回落到下面的常见位置 */ }
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
  if (base && fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith('chromium-')) continue;
      for (const rel of ['chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = path.join(base, entry, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  // 交给 playwright 自己决定（它会在启动时报出可读的错误）
  return undefined;
}

/** 断言计数与输出。 */
function createChecker() {
  const state = { failures: 0, passes: 0 };
  function check(label, ok, detail) {
    if (ok) state.passes += 1; else state.failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
  }
  function summary() {
    console.log('');
    console.log(`========== ${state.failures === 0 ? `全部通过（${state.passes} 项）` : `${state.failures} 项未通过（通过 ${state.passes} 项）`} ==========`);
    return state.failures === 0 ? 0 : 1;
  }
  return { check, summary, state };
}

/**
 * 启动带扩展的浏览器并备好被测页面。
 *
 * 返回的 extPage 是扩展上下文（能访问 chrome.* API），page 是被测页面（页面世界，
 * 访问不到 chrome.*）。需要改存储时用 extPage，需要读注入结果时用 page。
 */
async function launchWithExtension(sources) {
  const { chromium } = resolvePlaywright();
  const executablePath = resolveChrome(chromium);
  if (!fs.existsSync(EXT)) {
    throw new Error(
      `找不到构建产物 ${EXT}。请先执行 npm run build（测试加载的是真实产物，不是源码）。`,
    );
  }

  const servers = [];
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'qf-e2e-')), {
    headless: !process.env.QF_HEADED,
    executablePath,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  /** 起一个本地静态页，返回它的 URL。 */
  async function serve(html) {
    const http = require('http');
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/`;
  }

  /** 打开扩展页面：选项页负责把默认配置落盘，也兼作「能访问 chrome.* 的上下文」。 */
  async function openOptionsPage() {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.waitForTimeout(1500);
    return page;
  }

  async function close() {
    await context.close();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  }

  return { context, extId, serve, openOptionsPage, close };
}

module.exports = { ROOT, EXT, resolvePlaywright, resolveChrome, createChecker, launchWithExtension };