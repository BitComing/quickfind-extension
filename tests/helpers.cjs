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
    // 等「默认配置真的落盘」而不是固定睡 1.5 秒。
    //
    // 为什么不能省掉这一步：选项页启动时会做一次迁移写入（seed / 版本升级），它比页面
    // 加载晚完成；用例随后自己写 sources / groups，若迁移写入落在后面就会把用例的配置覆盖掉。
    // 为什么不能只是等页面加载完：写入是异步的，加载完成不代表写完了。
    // 判据取迁移写入的产物本身：sources、pinnedSearch、sourceConfigVersion 三者都在，
    // 说明那一笔（或本来就已经是迁移后的形状）已经生效。600ms 起步、最长 10 秒兜底，
    // 既不会因为机器快而多等，也不会因为慢而随机失败。
    await page.waitForFunction(() => new Promise((resolve) => {
      try {
        chrome.storage.sync.get(['sources', 'pinnedSearch', 'sourceConfigVersion'], (all) => {
          resolve(Boolean(all && Array.isArray(all.sources) && all.sources.length && all.pinnedSearch && all.sourceConfigVersion !== undefined));
        });
      } catch { resolve(false); }
    }), null, { timeout: 10000, polling: 50 }).catch(() => { /* 超时仍然继续：让用例自己报它依赖的前置条件 */ });
    return page;
  }

  async function close() {
    await context.close();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  }

  return { context, extId, serve, openOptionsPage, close };
}

/**
 * 收起常驻搜索栏 —— 走真实用户路径：指针移出栏与飞层后，按 collapseDelay 自动收起。
 *
 * 收起按钮已于 2026-10-20 按用户要求移除，用例不能再靠点它来收起。
 * 指针离开后由 window 上的 pointermove 恢复收起排定，到点自动收起；
 * 所以这里必须用真实指针移动（`page.mouse.move`），不能用脚本直接改 class ——
 * 那样会绕过收起排定本身，把「自动收起是否还生效」这条契约一起架空。
 */
async function collapsePinnedBar(page, hostSelector, { timeout = 5000 } = {}) {
  const viewport = page.viewportSize() || { width: 1100, height: 800 };
  const away = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height * 0.7) };
  // 先落到别处再横移一段：同一坐标重复 move 不一定派发 pointermove。
  await page.mouse.move(away.x - 40, away.y);
  await page.mouse.move(away.x, away.y);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const collapsed = await page.evaluate(
      (selector) => document.querySelector(selector)?.classList.contains('is-collapsed') ?? null,
      hostSelector,
    );
    if (collapsed) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/**
 * 等扩展在这个页面上真的就位，代替「goto 之后固定睡 1.4~1.6 秒」。
 *
 * 那段睡眠等的是内容脚本的异步启动：storage.get 回调 → 挂载宿主 → 按配置建常驻栏。
 * 直接等产物出现，通常 200~400ms 就够，机器慢时也不会随机失败。
 *
 * pinned=false 用于常驻栏本来就不该出现的页面（allSites:false / sites:[]），
 * 否则会白等到超时。
 */
async function waitExtensionReady(page, { pinned = true, timeout = 10000 } = {}) {
  await page.waitForSelector('#quickfind-shadow-host', { state: 'attached', timeout });
  if (!pinned) return;
  await page.waitForFunction(() => {
    const host = document.querySelector('#quickfind-pinned-search-host');
    return Boolean(host && host.shadowRoot && host.shadowRoot.querySelector('.bar'));
  }, null, { timeout }).catch(() => { /* 常驻栏没建出来时交给用例自己的前置条件断言 */ });
}

/**
 * 读 `shared/features.ts` 里的模块开关。
 *
 * 下线模块的用例不必跟着删：它们在开头问一句「这个模块还开着吗」，关着就明确跳过，
 * 开关改回 `true` 时原样继续跑。开关是编译期常量，所以直接读源码，不必起浏览器。
 */
function featureEnabled(name) {
  const source = fs.readFileSync(path.join(ROOT, 'shared', 'features.ts'), 'utf8');
  const match = new RegExp(`export const ${name}\\s*=\\s*(true|false)`).exec(source);
  return match ? match[1] === 'true' : true;
}

/**
 * 已下线模块的跳过出口。
 *
 * 退出码 0，但输出里有一行 `SKIP`，`run.mjs` 会把它汇总成「跳过」而不是「通过」——
 * 两者的区别很重要：通过代表断言真的跑过。
 */
function skipRetired(reason) {
  console.log(`  SKIP  ${reason}（见 shared/features.ts）`);
  console.log('\n========== 跳过（模块已下线） ==========');
  process.exit(0);
}

module.exports = { ROOT, EXT, resolvePlaywright, resolveChrome, createChecker, launchWithExtension, collapsePinnedBar, waitExtensionReady, featureEnabled, skipRetired };