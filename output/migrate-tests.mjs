// 一次性迁移工具（用完即删）：把 output/playwright 的回归脚本搬进 tests/，
// 并把三类硬编码绝对路径换成 helpers.cjs 提供的解析结果。
//
// 只替换路径相关的最小片段，测试逻辑一行不动——这样迁移后「跑出来的结论应该完全一样」，
// 可以用执行前后断言数是否相同来验证。

import fs from 'node:fs';
import path from 'node:path';

const SRC = 'output/playwright';
const DST = 'tests';
fs.mkdirSync(DST, { recursive: true });

const files = fs.readdirSync(SRC).filter((f) => /^verify.*\.cjs$/.test(f));
const PW_RE = /const \{ chromium \} = require\('C:\/Users\/Alpha\/node_modules\/playwright'\);/;
const ROOT_RE = /const ROOT = 'C:\/Users\/Alpha\/Documents\/ChatGPT\/快速搜索插件';/;
const EXT_RE = /const EXT = path\.join\(ROOT, '\.output\/chrome-mv3'\);\r?\n/;
const CHROME_RE = /const CHROME = 'C:\/Users\/Alpha\/AppData\/Local\/ms-playwright\/chromium-\d+\/chrome-win\/chrome\.exe';/;

for (const file of files) {
  const from = path.join(SRC, file);
  let src = fs.readFileSync(from, 'utf8');
  const marks = [];

  if (PW_RE.test(src)) {
    src = src.replace(PW_RE, "const { resolvePlaywright } = require('./helpers.cjs');\nconst { chromium } = resolvePlaywright();");
    marks.push('playwright');
  }
  if (ROOT_RE.test(src)) {
    src = src.replace(ROOT_RE, "const { ROOT, EXT, resolveChrome } = require('./helpers.cjs');");
    marks.push('ROOT');
  }
  if (EXT_RE.test(src)) {
    src = src.replace(EXT_RE, '');
    marks.push('EXT');
  }
  if (CHROME_RE.test(src)) {
    src = src.replace(CHROME_RE, 'const CHROME = resolveChrome(chromium);');
    marks.push('CHROME');
  }
  const headless = /headless: false,/g;
  if (headless.test(src)) {
    src = src.replace(/headless: false,/g, 'headless: !process.env.QF_HEADED,');
    marks.push('headless');
  }

  fs.writeFileSync(path.join(DST, file), src);
  console.log(`✅ ${file}  已替换: ${marks.join(', ') || '（无匹配）'}`);
}
console.log(`\n迁移完成，共 ${files.length} 个文件 → ${DST}/`);