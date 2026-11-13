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

export function normalizeSideChannelBaseUrl(url: string): string {
  const value = url.trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/\/chat\/completions$/i.test(value)) return value.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(value)) return `${value}/v1`;
  return value;
}

/**
 * 校验并返回规范化后的副渠道 HTTP(S) 基地址。
 * 拒绝空串、相对路径或非 http(s) 协议，防止 `reverse_proxy: ""` 触发酒馆回退主 OpenAI Key。
 */
export function requireValidSideChannelBaseUrl(url: string): string {
  const normalized = normalizeSideChannelBaseUrl(url);
  if (!normalized) {
    throw new Error('请先填写副 API 地址');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('副 API 地址无效，请填写以 http:// 或 https:// 开头的完整地址');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('副 API 地址必须使用 http:// 或 https:// 协议');
  }
  return normalized;
}
