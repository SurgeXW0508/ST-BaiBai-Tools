import {
  EXCLUDABLE_MODEL_PARAMS,
  filterExcludeParams,
  normalizeSideChannelBaseUrl,
  requireValidSideChannelBaseUrl,
  sanitizeExcludeParams,
} from '@pen/api/channelParams';
import type { ApiChannel } from '@pen/api/sharedChannels';
import { getContext } from '@pen/st/context';

export { EXCLUDABLE_MODEL_PARAMS, filterExcludeParams, sanitizeExcludeParams };

const GENERATE_URL = '/api/backends/chat-completions/generate';
const STATUS_URL = '/api/backends/chat-completions/status';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

function resolveValidEndpointUrl(rawUrl: string): string {
  try {
    return requireValidSideChannelBaseUrl(rawUrl);
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error));
  }
}

async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(controller.signal);
  } catch (error) {
    if (timedOut) throw new ApiError(`副 API 请求超时(>${timeoutSec}秒)`);
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function extractContent(data: any): string {
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.content ??
    ''
  ).trim();
}

async function readSseContent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return extractContent(await response.json().catch(() => null));
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith('data:')) continue;
      const payload = text.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        if (data?.error) throw new ApiError(data.error.message || '副 API 返回错误');
        const delta =
          data?.choices?.[0]?.delta?.content ??
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text;
        if (typeof delta === 'string') output += delta;
      } catch (error) {
        if (error instanceof ApiError) throw error;
      }
    }
  }
  return output.trim();
}

/**
 * 构造发给 ST 代理的请求体（两阶段结构隔离：采样参数层 + 不可变路由/认证信封层）。
 *
 * 1. 阶段 1 仅组装可被 `EXCLUDABLE_MODEL_PARAMS` 白名单排除的模型采样参数；
 * 2. 阶段 2 强制校验 `http(s)://` 端点地址，并固定写入 `chat_completion_source`、
 *    地址与凭据绑定（`openai` 源的 `reverse_proxy` + `proxy_password`，或 `custom` 源的
 *    `custom_url` + 显式 `Authorization` 头）、`model`、`messages`、`stream`。
 *    控制与认证字段在结构上永远不经过 `excludeParams` 删除逻辑，彻底阻断回退使用酒馆主密钥。
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMessage[],
  reverseProxy: string,
): Record<string, unknown> {
  const endpointUrl = resolveValidEndpointUrl(reverseProxy);
  const excluded = new Set(filterExcludeParams(channel.excludeParams));
  const rawEffort = channel.reasoningEffort?.trim() ?? '';
  const effort = excluded.has('reasoning_effort') ? '' : rawEffort;

  const samplingParams: Record<string, unknown> = {
    temperature: channel.temperature ?? 1,
    max_tokens: channel.maxTokens ?? 65535,
    presence_penalty: 0,
    frequency_penalty: 0,
  };
  for (const key of excluded) {
    delete samplingParams[key];
  }

  const corePayload = {
    model: channel.model,
    messages,
    ...samplingParams,
    stream: channel.stream ?? false,
  };

  if (effort) {
    return {
      chat_completion_source: 'custom',
      custom_url: endpointUrl,
      custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
      custom_include_body: JSON.stringify({ reasoning_effort: effort }),
      ...corePayload,
    };
  }

  return {
    chat_completion_source: 'openai',
    reverse_proxy: endpointUrl,
    proxy_password: channel.key || '',
    ...corePayload,
  };
}

async function requestAtUrl(
  channel: ApiChannel,
  messages: ChatMessage[],
  reverseProxy: string,
  signal?: AbortSignal,
): Promise<string> {
  const context = getContext();
  if (!context) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url.trim() || !channel.model.trim()) {
    throw new ApiError('副 API 渠道未配置完整（缺少地址或模型）');
  }

  const outputMessages =
    channel.prefill === false && messages.at(-1)?.role === 'assistant'
      ? messages.slice(0, -1)
      : messages;
  const body = buildRequestBody(channel, outputMessages, reverseProxy);

  const timeoutSec =
    Number.isFinite(channel.timeoutSec) && channel.timeoutSec > 0
      ? Math.floor(channel.timeoutSec)
      : DEFAULT_TIMEOUT_SEC;
  return withTimeout(timeoutSec, signal, async requestSignal => {
    const response = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(`副 API 请求失败 (${response.status})：${text.slice(0, 300)}`, response.status);
    }
    const content = channel.stream
      ? await readSseContent(response)
      : extractContent(await response.json());
    if (!content) throw new ApiError('副 API 返回空内容');
    return content;
  });
}

export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  return requestAtUrl(channel, messages, resolveValidEndpointUrl(channel.url), signal);
}

export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  let primaryUrl: string;
  try {
    primaryUrl = resolveValidEndpointUrl(channel.url);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const reply = await requestAtUrl(
      channel,
      [{ role: 'user', content: '回复“ok”两个字符即可。' }],
      primaryUrl,
    );
    if (normalizeSideChannelBaseUrl(channel.url) === primaryUrl && channel.url.trim().replace(/\/+$/, '') !== primaryUrl) {
      channel.url = primaryUrl;
    }
    return { ok: true, message: `连通正常，返回：${reply.slice(0, 40)}` };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const fallbackUrl = alternateUrl(primaryUrl);
    try {
      const reply = await requestAtUrl(
        channel,
        [{ role: 'user', content: '回复“ok”两个字符即可。' }],
        fallbackUrl,
      );
      channel.url = fallbackUrl;
      return { ok: true, message: `连通正常，已改用：${fallbackUrl}，返回：${reply.slice(0, 40)}` };
    } catch {
      return { ok: false, message: error.message };
    }
  }
}

export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key' | 'timeoutSec'>,
): Promise<string[]> {
  const context = getContext();
  if (!context) throw new ApiError('SillyTavern 上下文不可用');
  const reverseProxy = resolveValidEndpointUrl(channel.url);

  const timeoutSec =
    Number.isFinite(channel.timeoutSec) && channel.timeoutSec > 0
      ? Math.floor(channel.timeoutSec)
      : DEFAULT_TIMEOUT_SEC;
  return withTimeout(timeoutSec, undefined, async signal => {
    const response = await fetch(STATUS_URL, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
      }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${response.status})：${text.slice(0, 200)}`);
    }
    const data = await response.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || '拉取模型失败');
    }
    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((item: any) => (typeof item === 'string' ? item : item?.id))
      .filter((item: unknown): item is string => typeof item === 'string' && !!item)
      .sort();
  });
}
