/**
 * 会员与激活码。
 *
 * 免费版的边界是两条**同时生效**的限制：最多 `FREE_GROUP_LIMIT` 个搜索源分组、
 * 最多 `FREE_SOURCE_LIMIT` 个**已启用**的搜索源；激活会员后两条都不限。
 * 价格、有效期、激活码格式都在这里声明一次，选项页「关于」与生成脚本都从这一份读。
 *
 * 这两条上限、以及整个会员版面，都由下面的 `PAID_FEATURES_ENABLED` 统管：它现在是
 * `false`，也就是**全部功能免费**——配额不设上限，「关于」页只留版本号。
 *
 * ── 校验为什么在服务端，而许可证为什么在本地 ─────────────────────────
 * 旧版把「套餐 + 流水号 + 固定盐哈希」全放在码里，读到源码的人就能算出一模一样的
 * 签名——那不是防伪，只是防抄错。现在激活必须联网：邮箱 + 激活码 → 服务端查库 →
 * 签发一张 ES256 许可证（见 shared/license-api.ts）。
 *
 * 联网只发生在「激活」「续期」「停用」三个动作上，**不是每次启动**。已激活的设备拿
 * 到的是服务端私钥签名的许可证，扩展内置公钥离线验签，所以服务器宕机、用户断网，
 * 会员状态照常成立。这是「安全」与「可用」之间唯一说得通的切法。
 *
 * 仍然要说清楚边界：扩展的 JS 用户看得见也改得动，本地把校验删掉自己用是挡不住的。
 * 这里挡的是「一码传全班」和「自己造码」，靠的是服务端设备数与吊销。
 *
 * 分组配额只数「用户自己建的分组」：随扩展附带的预设分组（见 defaults.ts 的
 * DEFAULT_GROUPS）不计入。否则全新安装一落地就有预设分组，免费用户在第一次点
 * 「新建分组」时就会被告知已达上限，看起来像功能坏了。
 */

import { DEFAULT_GROUPS } from './defaults';
import type { SearchGroup } from './settings';

/**
 * 会员（付费）功能总开关。
 *
 * `false` = 全部功能免费，界面上也不出现任何付费信息：
 * 分组与搜索源的配额函数直接返回「不限」，「关于」页只渲染版本号，
 * 套餐卡、激活码、购买说明三块整块 `hidden`（见 options/index.html 的 `data-paid`）。
 *
 * 这里只关「展示与限制」，不删代码：DOM、文案、激活与续期的逻辑原样留着，
 * 把这一行改回 `true` 就恢复付费版面，其他文件一行都不用动。
 */
export const PAID_FEATURES_ENABLED: boolean = false;

/** 免费版最多创建几个搜索源分组。`PAID_FEATURES_ENABLED` 为 false 时不起作用。 */
export const FREE_GROUP_LIMIT = 2;
/** 免费版最多保存几个搜索源。`PAID_FEATURES_ENABLED` 为 false 时不起作用。 */
export const FREE_SOURCE_LIMIT = 20;

export type LicensePlan = 'yearly' | 'lifetime';

export interface PlanInfo {
  id: LicensePlan;
  /** 套餐名，页面上直接显示。 */
  label: string;
  /** 价格文案。 */
  price: string;
  /** 价格后缀，如「/ 年」。 */
  period: string;
  /** 卡片上的权益行，两三条短句，不写解释。 */
  features: string[];
  /** 有效期天数，永久为 null。 */
  days: number | null;
  /** 悬停说明：界面不放解释性文案，细节都写进 title。 */
  hint: string;
}

/** 售卖中的套餐。顺序即页面顺序。 */
export const PLANS: PlanInfo[] = [
  {
    id: 'yearly',
    label: '一年会员',
    price: '5 元',
    period: '/ 年',
    features: ['搜索源分组不限', '搜索源不限数量'],
    days: 365,
    hint: '激活后 365 天内，搜索源分组与搜索源都不限数量',
  },
  {
    id: 'lifetime',
    label: '永久会员',
    price: '10 元',
    period: '/ 永久',
    features: ['搜索源分组不限', '搜索源不限数量'],
    days: null,
    hint: '一次激活，搜索源分组与搜索源长期不限数量',
  },
];

/** 已激活的会员。存进 sync，换一台装的浏览器也能用。 */
export interface LicenseRecord {
  /** 归一化后的激活码（`XXXX-XXXX-XXXX`），用于在界面上回显。 */
  code: string;
  plan: LicensePlan;
  activatedAt: number;
  /** 永久会员为 null。 */
  expiresAt: number | null;
  /** 激活时使用的邮箱。老记录（服务端上线前激活的）没有这个字段。 */
  email?: string;
  /** 服务端签发的 ES256 许可证，离线验签用。 */
  token?: string;
  /** 许可证自身的到期时间（毫秒）。到期后需要联网续期，不影响会员到期时间。 */
  tokenExp?: number;
  /** 续期令牌。只在扩展本地与 sync 里，用于静默续期。 */
  refreshToken?: string;
  /** 续期令牌到期时间（毫秒）。 */
  refreshExp?: number;
}

export function planById(id: unknown): PlanInfo | null {
  const key = String(id ?? '');
  return PLANS.find((plan) => plan.id === key) || null;
}

// ── 激活码编解码 ──────────────────────────────────────────────────────
// 形状：`QF` + 套餐字 + 9 位随机 = 12 位，按 4 位一组显示，例如 `QFP-XXXX-XXXX`。
// 字符集去掉 I / L / O / U，抄写时不至于把 0 认成 O。
//
// 注意这里**不做有效性判断**：码在不在库里、有没有被停用、是不是绑给了这个邮箱，
// 全部由服务端回答。本地能做的只有「格式对不对」，多算一步也只是给用户多一句
// 自欺欺人的提示。

/** 易混字符已剔除的 base32 字母表。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'QF';
const PLAN_CHARS: Record<LicensePlan, string> = { yearly: 'Y', lifetime: 'P' };
const SERIAL_LENGTH = 9;
/** 12：`QF` + 套餐字 + 随机 9。熵约 45 bit，配合服务端限流足以挡住在线猜码。 */
const CODE_LENGTH = PREFIX.length + 1 + SERIAL_LENGTH;

/**
 * 归一化用户抄进来的码：去分隔符、转大写，把字母表里没有的 I / L / O 按 Crockford
 * 的惯例还原成 1 / 1 / 0。
 */
export function normalizeActivationCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 显示用：4 位一组，中间补连字符。长度不对时原样返回，交给校验去报错。 */
export function formatActivationCode(input: unknown): string {
  const normalized = normalizeActivationCode(input);
  if (normalized.length !== CODE_LENGTH) return String(input ?? '').trim();
  return [0, 4, 8].map((start) => normalized.slice(start, start + 4)).join('-');
}

/**
 * 生成方向在服务端（`license-server/scripts/gencodes.py`）。扩展不造码：
 * 造码能力意味着能自签，那和没授权是一回事。
 */

export type CodeCheck = { ok: true; plan: LicensePlan; serial: string } | { ok: false; error: string };

/**
 * 只校验「形状」：长度、前缀、套餐字、字母表。
 * 通过不等于有效——是否有效由 `/v1/activate` 回答。
 */
export function parseActivationCode(input: unknown): CodeCheck {
  const normalized = normalizeActivationCode(input);
  if (!normalized) return { ok: false, error: '请输入激活码。' };
  if (normalized.length !== CODE_LENGTH || !normalized.startsWith(PREFIX)) return { ok: false, error: '激活码格式不正确。' };
  const body = normalized.slice(PREFIX.length);
  const planChar = body.slice(0, 1);
  const plan = PLANS.find((item) => PLAN_CHARS[item.id] === planChar)?.id;
  if (!plan) return { ok: false, error: '激活码格式不正确。' };
  const serial = body.slice(1, 1 + SERIAL_LENGTH);
  if ([...serial].some((char) => !ALPHABET.includes(char))) return { ok: false, error: '激活码格式不正确。' };
  return { ok: true, plan, serial };
}

/**
 * 把 `/v1/activate` 的响应变成一条本地记录。
 *
 * 有效期以服务端的 `expires_at` 为准（服务端在**首次激活**时起算，见
 * `app/main.py` 的 activate）。本地不再自己算 365 天——两处各算一遍迟早会漂移。
 */
export function recordFromServer(
  input: {
    code: string;
    email: string;
    plan: string;
    expires_at: number | null;
    license: { token: string; exp: number };
    refresh: { token: string; exp: number };
  },
  now: number = Date.now()
): LicenseRecord | null {
  const plan = planById(input.plan)?.id;
  if (!plan || !input.license?.token) return null;
  return {
    code: formatActivationCode(input.code),
    plan,
    activatedAt: now,
    expiresAt: input.expires_at ? input.expires_at * 1000 : null,
    email: String(input.email || ''),
    token: input.license.token,
    tokenExp: input.license.exp * 1000,
    refreshToken: input.refresh?.token,
    refreshExp: input.refresh?.exp * 1000,
  };
}

/** 存储里读出来的记录可能缺字段、可能被手改过，收敛成可用的记录或 null。 */
export function normalizeLicenseRecord(value: unknown): LicenseRecord | null {
  const raw = value as Partial<LicenseRecord> | null | undefined;
  if (!raw || !raw.code) return null;
  const check = parseActivationCode(raw.code);
  if (!check.ok) return null;
  const plan = planById(raw.plan)?.id || check.plan;
  const activatedAt = Number(raw.activatedAt) > 0 ? Number(raw.activatedAt) : 0;
  if (!activatedAt) return null;
  // 服务端上线前的记录没有 token，也没有可靠的 expiresAt：按套餐天数从激活时刻补算。
  const fallbackExpiry = plan === 'lifetime' ? null : activatedAt + (planById(plan)?.days ?? 0) * 24 * 60 * 60 * 1000;
  const storedExpiry = Number(raw.expiresAt);
  return {
    code: formatActivationCode(raw.code),
    plan,
    activatedAt,
    expiresAt: raw.expiresAt === null || !Number.isFinite(storedExpiry) ? fallbackExpiry : storedExpiry,
    email: raw.email ? String(raw.email) : undefined,
    token: raw.token ? String(raw.token) : undefined,
    tokenExp: Number(raw.tokenExp) > 0 ? Number(raw.tokenExp) : undefined,
    refreshToken: raw.refreshToken ? String(raw.refreshToken) : undefined,
    refreshExp: Number(raw.refreshExp) > 0 ? Number(raw.refreshExp) : undefined,
  };
}

/**
 * 写进 sync 的只有「身份信息」：买了什么、到什么时候、绑的哪个邮箱。
 *
 * 令牌（token / refreshToken）属于**这台设备**，必须留在 local：sync 是同一个浏览器账号
 * 共享的，5 台设备各自续期会互相覆盖，最后只剩最后一台能续期。
 */
export function toSyncRecord(record: LicenseRecord): LicenseRecord {
  return {
    code: record.code,
    plan: record.plan,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    email: record.email,
  };
}

/** 会员是否在有效期内。永久会员永远有效；限时会员按 expiresAt 判断。 */
export function isMembershipActive(license: LicenseRecord | null | undefined, now: number = Date.now()): boolean {
  const record = license ? normalizeLicenseRecord(license) : null;
  if (!record) return false;
  if (record.plan === 'lifetime') return true;
  return Number(record.expiresAt) > now && record.activatedAt <= now + 60 * 1000;
}

export interface LicenseStatus {
  active: boolean;
  /** 已过期（有记录但不在有效期内）。 */
  expired: boolean;
  /** 一句话状态：未激活 / 一年会员 / 永久会员 / 已过期。 */
  label: string;
  plan: LicensePlan | null;
  expiresAt: number | null;
}

/** 界面上「当前状态」那一行要显示的全部内容。 */
export function describeLicense(license: LicenseRecord | null | undefined, now: number = Date.now()): LicenseStatus {
  const record = license ? normalizeLicenseRecord(license) : null;
  if (!record) return { active: false, expired: false, label: '未激活', plan: null, expiresAt: null };
  const active = isMembershipActive(record, now);
  const plan = planById(record.plan);
  if (!active) return { active: false, expired: true, label: '已过期', plan: record.plan, expiresAt: record.expiresAt };
  return { active: true, expired: false, label: plan?.label || '会员', plan: record.plan, expiresAt: record.expiresAt };
}

/** `2027-11-07`。界面只用这一种日期形状，避免各入口格式不一。 */
export function formatExpiryDate(timestamp: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── 分组配额 ─────────────────────────────────────────────────────────

/**
 * 随扩展附带的预设分组 id：它们不占免费配额。
 *
 * 已下线的预设分组（其他 / 社媒 / ai）也留在这里：老用户的存储里还有它们，
 * 默认配置精简后不该把这些分组突然算成「用户自己建的」，让免费额度凭空超额。
 */
export const PRESET_GROUP_IDS: ReadonlySet<string> = new Set([...DEFAULT_GROUPS.map((group) => String(group.id)), 'group-other', 'group-social', 'group-ai']);

/** 用户自己建的分组数量（不含默认组与预设分组）。 */
export function countUserGroups(groups: SearchGroup[] | null | undefined): number {
  return (groups || []).filter((group) => {
    const id = String(group?.id ?? '');
    return Boolean(id) && id !== 'default' && !PRESET_GROUP_IDS.has(id);
  }).length;
}

export interface GroupQuota {
  /** 上限；会员为 Infinity。 */
  limit: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  /** 现在还能不能再建一个。 */
  allowed: boolean;
}

/**
 * 当前配额。`license` 传 null 即免费版；`PAID_FEATURES_ENABLED` 关掉时永远是「不限」，
 * 与有没有许可证无关——付费功能整个下线了，配额也就不该再拦人。
 */
export function groupQuota(groups: SearchGroup[] | null | undefined, license: LicenseRecord | null | undefined, now: number = Date.now()): GroupQuota {
  const used = countUserGroups(groups);
  if (!PAID_FEATURES_ENABLED || isMembershipActive(license, now)) {
    return { limit: Number.POSITIVE_INFINITY, used, remaining: Number.POSITIVE_INFINITY, unlimited: true, allowed: true };
  }
  return { limit: FREE_GROUP_LIMIT, used, remaining: Math.max(0, FREE_GROUP_LIMIT - used), unlimited: false, allowed: used < FREE_GROUP_LIMIT };
}

// ── 搜索源配额 ───────────────────────────────────────────────────────
// 这条与分组配额同时生效：免费版两项都卡，会员两项都不限。
//
// 计数口径是「已启用的搜索源」：全新安装只启用 5 个，其余内置源虽留在配置里但不占名额；
// 关掉一个就腾出一个名额。这样「免费 20 个」约束的是同时在用的量，而不是目录里存了多少。

export interface SourceQuota {
  limit: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  /** 现在还能不能再加一个。 */
  allowed: boolean;
}

export function sourceQuota(sources: Array<{ enabled?: boolean }> | null | undefined, license: LicenseRecord | null | undefined, now: number = Date.now()): SourceQuota {
  const used = Array.isArray(sources) ? sources.filter((source) => source?.enabled !== false).length : 0;
  if (!PAID_FEATURES_ENABLED || isMembershipActive(license, now)) {
    return { limit: Number.POSITIVE_INFINITY, used, remaining: Number.POSITIVE_INFINITY, unlimited: true, allowed: true };
  }
  return { limit: FREE_SOURCE_LIMIT, used, remaining: Math.max(0, FREE_SOURCE_LIMIT - used), unlimited: false, allowed: used < FREE_SOURCE_LIMIT };
}