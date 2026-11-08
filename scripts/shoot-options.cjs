/**
 * 选项页截图：每个仍在的设置页各一张，用来对比改动前后的视觉。
 * 用法：node scripts/shoot-options.cjs [标签]（先 npm run build）
 *
 * 截图落在 output/shots/（已 gitignore），文件名前缀取 QF_LABEL 或命令行第一个参数。
 */
const path = require('path');
const fs = require('fs');
const { launchWithExtension } = require('../tests/helpers.cjs');

const OUT = path.resolve(__dirname, '..', 'output', 'shots');
const LABEL = process.env.QF_LABEL || process.argv[2] || 'options';
/** 第二个参数是视口宽度；不给就按桌面宽度拍。 */
const WIDTH = Number(process.argv[3] || 1180);
const PANELS = ['common', 'sources', 'llm', 'history', 'about'];

/** 让截图里的内容不是空的：几条历史、一份配置。 */
const SEED = {
  searchHistory: [
    { query: '绿电炼铝 产能置换', timestamp: Date.now() - 1000 * 60 * 6 },
    { query: 'playwright 扩展加载 headless', timestamp: Date.now() - 1000 * 60 * 60 * 5 },
    { query: 'Workflowy 大纲 层级模型', timestamp: Date.now() - 1000 * 60 * 60 * 30 },
  ],
  llm: { enabled: false, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: '', systemPrompt: '' },
};

(async () => {
  const env = await launchWithExtension();
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const page = await env.openOptionsPage();
    await page.evaluate((seed) => new Promise((resolve) => chrome.storage.sync.set(seed, resolve)), SEED);
    await page.reload();
    await page.waitForTimeout(900);
    await page.setViewportSize({ width: WIDTH, height: 900 });

    // 只拍真的还在的页：下线模块（见 shared/features.ts）对应的导航项不在 DOM 里，
    // 对着它 click 会白等 30 秒然后报超时。
    const present = await page.evaluate((panels) => panels.filter(
      (panel) => Boolean(document.querySelector(`.nav-item[data-panel="${panel}"]`)),
    ), PANELS);
    for (const panel of present) {
      await page.click(`.nav-item[data-panel="${panel}"]`);
      await page.waitForTimeout(220);
      const file = path.join(OUT, `${LABEL}-${panel}.png`);
      await page.screenshot({ path: file });
      console.log('已存', path.basename(file));
    }
  } finally {
    await env.close();
  }
})().catch((error) => { console.error(error); process.exit(2); });