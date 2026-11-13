/**
 * 副渠道可排除的模型生成参数白名单与端点地址校验。
 *
 * 为什么必须使用显式白名单：
 * 副渠道请求经 ST 后端 `/api/backends/chat-completions/generate` 转发，请求体同时承载
 * 路由与凭据控制字段（如 `chat_completion_source`、`reverse_proxy`、`proxy_password`、
 * `custom_url`、`custom_include_headers`、`custom_include_body`）以及发往模型的采样参数。
 * 若允许排除控制字段，后端会回退读取酒馆自身保存的 Custom / OpenAI 密钥并发送到副渠道地址。
 */
export const EXCLUDABLE_MODEL_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'seed',
  'stop',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'reasoning_effort',
  'verbosity',
]);

export interface SanitizedExcludeParams {
  allowed: string[];
  rejected: string[];
}

function collectRawEntries(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .flatMap(item => item.split(','))
      .map(item => item.trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function sanitizeExcludeParams(raw: unknown): SanitizedExcludeParams {
  const allowed: string[] = [];
  const rejected: string[] = [];
  const seenAllowed = new Set<string>();
  const seenRejected = new Set<string>();

  for (const entry of collectRawEntries(raw)) {
    if (EXCLUDABLE_MODEL_PARAMS.has(entry)) {
      if (!seenAllowed.has(entry)) {
        seenAllowed.add(entry);
        allowed.push(entry);
      }
    } else if (!seenRejected.has(entry)) {
      seenRejected.add(entry);
      rejected.push(entry);
    }
  }

  return { allowed, rejected };
}

export function filterExcludeParams(raw: unknown): string[] {
  return sanitizeExcludeParams(raw).allowed;
}

function parseSideChannelBaseUrl(
  rawUrl: string,
  options?: { appendDefaultV1?: boolean },
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('请先填写副 API 地址');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('副 API 地址无效，请填写以 http:// 或 https:// 开头的完整地址');
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('副 API 地址必须使用 http:// 或 https:// 协议');
  }
  if (parsed.username || parsed.password) {
    throw new Error('副 API 地址不能包含用户名或密码凭据');
  }
  if (parsed.search) {
    throw new Error('副 API 地址不能包含查询参数（?…）');
  }
  if (parsed.hash) {
    throw new Error('副 API 地址不能包含锚点片段（#…）');
  }

  const rawPathname = parsed.pathname.replace(/\/+$/, '');
  const hadEndpointSuffix = /\/(?:chat\/completions|models)$/i.test(rawPathname);
  let pathname = rawPathname
    .replace(/\/(?:chat\/completions|models)$/i, '')
    .replace(/\/+$/, '');

  if (!pathname && !hadEndpointSuffix && options?.appendDefaultV1 !== false) {
    pathname = '/v1';
  }

  return `${parsed.origin}${pathname}`;
}

export function normalizeSideChannelBaseUrl(url: string): string {
  if (!url.trim()) return '';
  return parseSideChannelBaseUrl(url, { appendDefaultV1: true });
}

/**
 * 校验并返回规范化后的副渠道 HTTP(S) 基地址。
 * 拒绝空串、相对路径、非 http(s) 协议、内嵌凭据、查询串与片段，
 * 防止 `reverse_proxy: ""` 触发酒馆回退主 OpenAI Key 或造成后端代理路由拼接污染。
 */
export function requireValidSideChannelBaseUrl(
  url: string,
  options?: { appendDefaultV1?: boolean },
): string {
  return parseSideChannelBaseUrl(url, options);
}
