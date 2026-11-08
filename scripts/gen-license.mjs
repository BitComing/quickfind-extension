#!/usr/bin/env node
/**
 * ⚠️ 2026-11-08 起这脚本**不能用来发码了**。
 *
 * 激活已改为服务端判定（邮箱 + 码 → `https://api.kpopcha.top/v1/activate`），
 * 库里没有的码一律无效。本脚本产出的码只有「形状对」，直接发给客户会激活失败。
 * 真正发码用服务端的 `license-server/scripts/gencodes.py issue --email … --plan …`。
 *
 * 它保留下来只剩一个用途：给回归用例造「格式正确」的码
 * （`tests/verify-about-membership-2026-11-07.cjs` 拿它验前端的 normalize/format）。
 *
 * ── 以下为旧说明（离线签名时代）──────────────────────────────────────
 *
 * 用法：
 *   node scripts/gen-license.mjs                    生成 1 枚一年期
 *   node scripts/gen-license.mjs yearly 10          生成 10 枚一年期
 *   node scripts/gen-license.mjs lifetime 3         生成 3 枚永久
 *   node scripts/gen-license.mjs --verify <激活码>   只校验，不生成
 *
 * 套餐：yearly（一年会员，5 元）、lifetime（永久会员，10 元）。
 *
 * 这里的哈希必须与 `shared/license.ts` 逐字一致：字母表、套餐字、盐、流水号长度、
 * 签名长度任何一处不同，码就验不过。两边是否还一致由
 * `tests/verify-about-membership-2026-11-07.cjs` 兜住——它用本脚本生成的码去真实页面
 * 激活，一旦漂移测试立刻失败。改算法时两处一起改。
 *
 * 校验是离线的（扩展没有服务端），所以本脚本产出的码不区分使用者、也不可吊销：
 * 发出去的码谁拿到都能激活。要防伪与退货，只能把校验搬到服务端。
 */

import process from 'node:process';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'QF';
const PLAN_CHARS = { yearly: 'Y', lifetime: 'P' };
const PLAN_LABELS = { yearly: '一年会员', lifetime: '永久会员' };
const PLAN_PRICES = { yearly: '5 元', lifetime: '10 元' };
const SERIAL_LENGTH = 5;
const SIGNATURE_LENGTH = 4;
const CODE_LENGTH = PREFIX.length + 1 + SERIAL_LENGTH + SIGNATURE_LENGTH;
const SIGNATURE_SALT = 'quickfind-membership-2026';

function hash32(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function signatureOf(payload) {
  let value = hash32(payload + SIGNATURE_SALT, 2166136261) >>> 0;
  let signature = '';
  for (let index = 0; index < SIGNATURE_LENGTH; index += 1) {
    signature += ALPHABET[value % ALPHABET.length];
    value = Math.floor(value / ALPHABET.length);
  }
  return signature;
}

function normalize(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function format(normalized) {
  if (normalized.length !== CODE_LENGTH) return normalized;
  return [0, 4, 8].map((start) => normalized.slice(start, start + 4)).join('-');
}

function randomSerial(random) {
  let serial = '';
  for (let index = 0; index < SERIAL_LENGTH; index += 1) {
    serial += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length))];
  }
  return serial;
}

/** 生成一枚码。`random` 可注入，便于测试固定流水号。 */
export function createCode(plan, random = Math.random) {
  if (!PLAN_CHARS[plan]) throw new Error(`未知套餐：${plan}`);
  const body = PLAN_CHARS[plan] + randomSerial(random);
  return format(PREFIX + body + signatureOf(body));
}

/** 校验一枚码，返回 { ok, plan } 或 { ok: false, error }。 */
export function verifyCode(input) {
  const normalized = normalize(input);
  if (!normalized) return { ok: false, error: '请输入激活码。' };
  if (normalized.length !== CODE_LENGTH || !normalized.startsWith(PREFIX)) return { ok: false, error: '激活码格式不正确。' };
  const body = normalized.slice(PREFIX.length);
  const planChar = body.slice(0, 1);
  const plan = Object.keys(PLAN_CHARS).find((id) => PLAN_CHARS[id] === planChar);
  if (!plan) return { ok: false, error: '激活码格式不正确。' };
  const serial = body.slice(1, 1 + SERIAL_LENGTH);
  const signature = body.slice(1 + SERIAL_LENGTH);
  if (signature !== signatureOf(planChar + serial)) return { ok: false, error: '激活码无效。' };
  return { ok: true, plan, serial };
}

function printUsage() {
  console.log('用法：');
  console.log('  node scripts/gen-license.mjs                生成 1 枚一年期');
  console.log('  node scripts/gen-license.mjs yearly 10      生成 10 枚一年期');
  console.log('  node scripts/gen-license.mjs lifetime 3     生成 3 枚永久');
  console.log('  node scripts/gen-license.mjs --verify <码>  校验一枚码');
}

function main(argv) {
  if (argv[0] === '--verify') {
    const result = verifyCode(argv[1]);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`有效：${PLAN_LABELS[result.plan]}（${PLAN_PRICES[result.plan]}），流水号 ${result.serial}`);
    return;
  }
  if (argv[0] === '-h' || argv[0] === '--help') { printUsage(); return; }

  const plan = argv[0] || 'yearly';
  if (!PLAN_CHARS[plan]) {
    console.error(`未知套餐：${plan}`);
    printUsage();
    process.exit(2);
  }
  const count = Math.max(1, Math.min(1000, Math.round(Number(argv[1]) || 1)));
  console.error('⚠️  这些码只在服务端发码后才有效。激活已改为服务端判定，');
  console.error('    本脚本产出的码没有入库，发给客户会「激活码无效」。');
  console.error('    真正发码：python3 license-server/scripts/gencodes.py issue --email <邮箱> --plan <套餐>');
  const codes = [];
  for (let index = 0; index < count; index += 1) {
    const code = createCode(plan);
    // 极低概率的流水号碰撞：同一批里重复就重生成，免得对账时两枚码分不清。
    if (codes.includes(code)) { index -= 1; continue; }
    codes.push(code);
  }
  console.log(`${PLAN_LABELS[plan]}（${PLAN_PRICES[plan]}）${count} 枚：`);
  codes.forEach((code, index) => console.log(`  ${String(index + 1).padStart(3, ' ')}. ${code}`));
}

// 只在直接运行时执行：被测试 import 时不该打印一堆码。
if (process.argv[1] && process.argv[1].endsWith('gen-license.mjs')) main(process.argv.slice(2));