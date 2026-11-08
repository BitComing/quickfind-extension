/**
 * 授权服务客户端。
 *
 * 为什么许可证要本地验签：断网、服务器维护、用户在公司网络里被拦，都不该让一个
 * 已经付过钱的用户打不开自己的分组。激活成功后服务端给一张 ES256 签名许可证，
 * 公钥内嵌在扩展里，用 WebCrypto 离线验——不引入任何第三方库，Chrome/Firefox 都自带。
 *
 * 威胁模型仍然要说清楚：扩展的前端代码用户看得见、改得动。这里挡住的是
 * 「把码转手卖给别人」「自己算一个码」，挡不住「本地把校验删掉自己用」。
 * 后者只能靠服务端能力兜，不在这一层的职责里。
 */

import type { LicensePlan } from './license';

/** 接口根。改这里等于换后端，域名与证书见 license-server/deploy/nginx-api.conf。 */
export const LICENSE_API_BASE = 'https://api.kpopcha.top/v1';

/**
 * 签名公钥（服务端 `/v1/pubkey` 的 jwk 字段，kid 见下）。
 * 换私钥必须同步发新版扩展，否则老用户全部验签失败。
 */
export const LICENSE_PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'hdQcSjbfxIkgfxys4ojyUGpJFVcgVvlZDn8C6zfcHqc',
  y: 'Y33178iXUHcuz1xnneuMzi9YSQmYWsYa36Vn9NmjSqA',
  ext: true,
  key_ops: ['verify']
};
export const LICENSE_KID = 'dc009d25883aa483';

const REQUEST_TIMEOUT_MS = 15000;
const DEVICE_ID_KEY = 'quickfind-device-id';

export interface ServerLicense {
  ok: true;
  email: string;
  plan: LicensePlan;
  /** 会员真正到期时间（毫秒），永久为 null。 */
  expires_at: number | null;
  max_devices: number;
  license: { token: string; exp: number; kid: string };
  refresh: { token: string; exp: number };
}

export type ApiFailure = { ok: false; error: string; message: string; retryable: boolean };
export type ApiResult = ServerLicense | ApiFailure;

/** 服务端 error 码 → 界面文案。服务端也回中文 message，但界面要跟着语言切换，所以在这里收口。 */
const ERROR_TEXT: Record<string, string> = {
  code_invalid: '激活码无效，请检查是否输入正确。',
  code_format: '激活码格式不正确。',
  email_invalid: '邮箱格式不正确。',
  email_mismatch: '邮箱与激活码不匹配。激活码与购买时填写的邮箱绑定。',
  device_limit: '该激活码已绑定设备数达到上限。请先在原设备上「清除激活码」，或联系卖家解绑。',
  code_disabled: '该激活码已被停用，请联系卖家。',
  license_expired: '该授权已到期。',
  rate_limited: '尝试次数过多，请稍后再试。',
  session_invalid: '登录状态已失效，请重新输入激活码。',
  session_expired: '登录状态已过期，请重新输入激活码。',
  device_revoked: '这台设备已被解绑，请重新激活。',
  server_error: '服务端异常，请稍后重试。'
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] || '激活失败，请稍后再试。';
}

/** 网络层失败：调用方据此决定是提示「检查网络」还是走离线宽容期。 */
function networkFailure(): ApiFailure {
  return { ok: false, error: 'network', message: '无法连接激活服务器，请检查网络后重试。', retryable: true };
}

async function post(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${LICENSE_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      return networkFailure();
    }
    if (response.ok && payload?.ok) return payload as ServerLicense;
    const code = String(payload?.error || (response.status === 429 ? 'rate_limited' : 'unknown'));
    return { ok: false, error: code, message: errorText(code), retryable: response.status >= 500 || response.status === 429 };
  } catch {
    return networkFailure();
  } finally {
    clearTimeout(timer);
  }
}

/** 本机设备标识：随机 UUID，存在 local（不随账号同步，换浏览器就是新设备）。 */
export async function getDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  const existing = String(stored?.[DEVICE_ID_KEY] || '');
  if (existing) return existing;
  const created =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: created });
  return created;
}

export async function activateLicense(email: string, code: string): Promise<ApiResult> {
  const deviceId = await getDeviceId();
  return post('/activate', {
    email: email.trim(),
    code: code.trim(),
    device_id: deviceId,
    app_version: chrome.runtime.getManifest?.().version || '1.0.0',
    platform: navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome'
  });
}

export async function refreshLicense(refreshToken: string): Promise<ApiResult> {
  const deviceId = await getDeviceId();
  return post('/refresh', { refresh_token: refreshToken, device_id: deviceId });
}

/** 停用：释放设备位。失败不阻塞本地清除——用户点的就是「我不在这台机器上用了」。 */
export async function releaseLicense(refreshToken: string): Promise<boolean> {
  const result = await post('/deactivate', { refresh_token: refreshToken });
  return result.ok !== false;
}

const PENDING_RELEASE_KEY = 'quickfind-pending-release';
const SESSION_KEY = 'quickfind-license-session';

/** 本机的设备凭证。放 local 不放 sync：sync 会在同一账号的多台设备间互相覆盖。 */
export interface LicenseSession {
  code: string;
  token: string;
  tokenExp: number;
  refreshToken: string;
  refreshExp: number;
}

export async function saveSession(session: LicenseSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function readSession(): Promise<LicenseSession | null> {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const raw = stored?.[SESSION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as LicenseSession;
  if (!session.token || !session.refreshToken) return null;
  return session;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_KEY);
}

/**
 * 把没发出去的停用请求记下来。
 *
 * 为什么要这一步：用户断网时点「清除激活码」，本地能清、服务端收不到，那个设备位就
 * 一直被他自己的旧设备占着，等于白丢一个名额（5 台上限下更明显）。记下来，下次打开
 * 设置页补发。
 */
export async function queuePendingRelease(refreshToken: string): Promise<void> {
  const stored = await chrome.storage.local.get(PENDING_RELEASE_KEY);
  const list: string[] = Array.isArray(stored?.[PENDING_RELEASE_KEY]) ? stored[PENDING_RELEASE_KEY] : [];
  if (list.includes(refreshToken)) return;
  await chrome.storage.local.set({ [PENDING_RELEASE_KEY]: [...list, refreshToken].slice(-10) });
}

/** 补发待释放的停用请求，返回这次清掉几条。 */
export async function flushPendingReleases(): Promise<number> {
  const stored = await chrome.storage.local.get(PENDING_RELEASE_KEY);
  const list: string[] = Array.isArray(stored?.[PENDING_RELEASE_KEY]) ? stored[PENDING_RELEASE_KEY] : [];
  if (!list.length) return 0;
  const remain: string[] = [];
  for (const token of list) {
    if (!(await releaseLicense(token))) remain.push(token);
  }
  await chrome.storage.local.set({ [PENDING_RELEASE_KEY]: remain });
  return list.length - remain.length;
}

export interface LicenseTokenPayload {
  v: number;
  sub: string;
  em: string;
  plan: LicensePlan;
  dev: string;
  iat: number;
  exp: number;
  ltd: number | null;
  jti: string;
}

function base64UrlToBytes(text: string): ArrayBuffer {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

let publicKeyPromise: Promise<CryptoKey> | null = null;

function importPublicKey(): Promise<CryptoKey> {
  publicKeyPromise ||= crypto.subtle.importKey(
    'jwk',
    LICENSE_PUBLIC_JWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return publicKeyPromise;
}

/**
 * 离线验签。token 形如 `qs1.<body>.<sig>`，签名对象就是 body 那一段的原始字节，
 * 所以这里不能重新序列化 JSON。
 */
export async function verifyLicenseToken(token: unknown): Promise<LicenseTokenPayload | null> {
  const text = String(token || '');
  const [prefix, bodyPart, signaturePart] = text.split('.');
  if (prefix !== 'qs1' || !bodyPart || !signaturePart) return null;
  try {
    const body = base64UrlToBytes(bodyPart);
    const signature = base64UrlToBytes(signaturePart);
    if (signature.byteLength !== 64) return null;
    const key = await importPublicKey();
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, body);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as LicenseTokenPayload;
    if (Number(payload?.exp) * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}