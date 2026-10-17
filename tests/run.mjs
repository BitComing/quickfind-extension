#!/usr/bin/env node
/**
 * 端到端回归入口。
 *
 * 每个用例都会自己加载构建产物跑真实浏览器，所以运行前必须先 `npm run build`——
 * 这里直接检查产物是否存在，缺了就给出明确提示，而不是让每个用例各自报错。
 *
 * 用法：
 *   npm run test:e2e              跑全部
 *   npm run test:e2e -- top       只跑文件名含 top 的
 *   QF_HEADED=1 npm run test:e2e  显示浏览器窗口（默认无头，便于 CI）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const EXT = path.join(ROOT, '.output', 'chrome-mv3');

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0] || '';

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`[e2e] 找不到构建产物：${EXT}`);
  console.error('[e2e] 回归跑的是真实产物而不是源码，请先执行 npm run build');
  process.exit(2);
}

const files = fs.readdirSync(TESTS)
  .filter((f) => /^verify.*\.(cjs|mjs)$/.test(f))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error(`[e2e] 没有匹配的用例${filter ? `（筛选：${filter}）` : ''}`);
  process.exit(2);
}

console.log(`[e2e] 共 ${files.length} 个用例${filter ? `（筛选：${filter}）` : ''}`);
console.log(`[e2e] 产物：${EXT}`);
console.log(`[e2e] 模式：${process.env.QF_HEADED ? '显示窗口' : '无头'}\n`);

const results = [];
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(TESTS, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  results.push({ file, code: result.status ?? 1, ms: Date.now() - started });
}

console.log('\n================ 汇总 ================');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✅' : '❌'}  ${r.file.padEnd(42)} ${(r.ms / 1000).toFixed(1)}s`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${failed.length === 0 ? `全部通过（${results.length} 个用例）` : `${failed.length}/${results.length} 个用例未通过`}`);
process.exit(failed.length === 0 ? 0 : 1);