#!/usr/bin/env node
/**
 * 端到端回归入口。
 *
 * 每个用例都会自己加载构建产物跑真实浏览器，所以运行前必须先 `npm run build`——
 * 这里直接检查产物是否存在，缺了就给出明确提示，而不是让每个用例各自报错。
 *
 * 并发：用例彼此独立（各自的临时 profile、各自的本地服务端口），串行跑只是历史遗留，
 * 一整轮 20 个用例串起来要 5 分钟，其中大半时间是在等浏览器自己干活。默认按核数并发，
 * 一轮压到一分多钟；用 `--serial` / `--jobs=N` / 环境变量 `QF_JOBS` 可以改。
 *
 * 用法：
 *   npm run test:e2e              跑全部（默认并发）
 *   npm run test:e2e -- top       只跑文件名含 top 的
 *   npm run test:e2e -- --serial  串行（排查并发干扰时用）
 *   QF_JOBS=6 npm run test:e2e    指定并发数
 *   QF_HEADED=1 npm run test:e2e  显示浏览器窗口（默认无头，便于 CI）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const EXT = path.join(ROOT, '.output', 'chrome-mv3');

const argv = process.argv.slice(2);
// 自己解析参数：`-j 4` 的 4 不能被当成筛选词（早先那版 `argv.find(a => !a.startsWith('-'))`
// 就会把它吃成筛选条件，于是「指定并发」变成「一个用例都没匹配上」）。
let filter = '';
let serial = false;
let jobsArg = '';
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--serial') serial = true;
  else if (arg.startsWith('--jobs=')) jobsArg = arg.slice('--jobs='.length);
  else if (arg === '-j') { jobsArg = argv[i + 1] || ''; i += 1; }
  else if (!arg.startsWith('-') && !filter) filter = arg;
}

/** `--jobs=4` / `-j 4` / `QF_JOBS=4` 三种写法都认；`--serial` 等价于 1。 */
function resolveJobs() {
  if (serial) return 1;
  const raw = jobsArg || process.env.QF_JOBS || '';
  const asked = Math.round(Number(raw));
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked, 16);
  // 每个用例都要起一个 Chromium：按核数的一半并发，4 是上限。
  // 再往上收益很小（单文件最长 40s 会成为新的下限），而 CPU 争抢会让时间敏感的
  // 用例（动画采样、固定等待）开始抖：实测 6 并发时 ask-ai 与 pinned-click 两个用例
  // 各出现过一次随机失败，4 并发连跑 5 轮全绿。
  return Math.min(4, Math.max(2, Math.floor((os.cpus().length || 2) / 2)));
}
/** 单个用例的最长运行时间：并发时某个用例卡死不该把整轮 CI 拖到 6 小时上限。 */
const FILE_TIMEOUT_MS = Number(process.env.QF_TEST_TIMEOUT_MS) || 10 * 60 * 1000;

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

const jobs = Math.min(resolveJobs(), files.length);
console.log(`[e2e] 共 ${files.length} 个用例${filter ? `（筛选：${filter}）` : ''}`);
console.log(`[e2e] 产物：${EXT}`);
console.log(`[e2e] 模式：${process.env.QF_HEADED ? '显示窗口' : '无头'}，并发 ${jobs}`);
console.log('');

const results = [];
let cursor = 0;
const t0 = Date.now();
const children = new Set();
// 父进程被 Ctrl+C 打断时把还在跑的用例一起收掉，不然并发模式下会留下几个孤儿 Chromium。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) { try { child.kill(); } catch { /* 已经退出 */ } }
    process.exit(130);
  });
}

/**
 * 跑一个用例。并发时子进程的逐字输出会互相穿插，所以整段缓冲到结束再一次性打印；
 * 每个用例的输出本来就是自成一段的（PASS/FAIL + 小结），这样读起来和串行时一致。
 */
function runFile(file, slot) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(TESTS, file)], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    children.add(child);
    child.stdout.on('data', (chunk) => { buffer += chunk; });
    child.stderr.on('data', (chunk) => { buffer += chunk; });
    if (jobs > 1) console.log(`[e2e] ▶ ${file}（槽 ${slot}）`);
    const killer = setTimeout(() => {
      console.error(`[e2e] ⏱ ${file} 超过 ${(FILE_TIMEOUT_MS / 1000).toFixed(0)}s，已终止`);
      try { child.kill(); } catch { /* 已经退出 */ }
    }, FILE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      children.delete(child);
      const ms = Date.now() - startedAt;
      const exit = typeof code === 'number' ? code : (signal ? 1 : 0);
      // 用例自己声明跳过（模块已下线）时不算「通过」：断言没有真的跑过。
      const skipped = exit === 0 && /========== 跳过/.test(buffer);
      process.stdout.write(buffer.endsWith('\n') || !buffer ? buffer : `${buffer}\n`);
      results.push({ file, code: exit, ms, skipped });
      console.log(`[e2e] ${exit !== 0 ? '❌' : skipped ? '⏭ ' : '✅'} ${file}  ${(ms / 1000).toFixed(1)}s\n`);
      resolve();
    });
  });
}

// 并发池：固定 jobs 个工人从队列里取，直到取完。
await Promise.all(Array.from({ length: jobs }, async (_, slot) => {
  while (true) {
    const index = cursor++;
    if (index >= files.length) return;
    await runFile(files[index], slot + 1);
  }
}));

const ordered = files.map((file) => results.find((r) => r.file === file)).filter(Boolean);
const totalMs = ordered.reduce((sum, r) => sum + r.ms, 0);

console.log('\n================ 汇总 ================');
for (const r of ordered) {
  console.log(`  ${r.code !== 0 ? '❌' : r.skipped ? '⏭ ' : '✅'}  ${r.file.padEnd(42)} ${(r.ms / 1000).toFixed(1)}s`);
}
const failed = ordered.filter((r) => r.code !== 0);
const skippedCount = ordered.filter((r) => r.skipped).length;
const wall = (Date.now() - t0) / 1000;
console.log(`\n${failed.length === 0 ? `全部通过（${ordered.length} 个用例${skippedCount ? `，其中 ${skippedCount} 个跳过` : ''}）` : `${failed.length}/${ordered.length} 个用例未通过`}`
  + `  用例耗时合计 ${(totalMs / 1000).toFixed(1)}s，总墙钟 ${wall.toFixed(1)}s（并发 ${jobs}）`);
process.exit(failed.length === 0 ? 0 : 1);