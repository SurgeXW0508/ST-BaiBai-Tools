import {
  getContext,
  getOpenChatId,
  getOpenChatIdentity,
  isChatStreaming,
  type STContext,
} from '@pen/st/context';

type SaveEndpointKind = 'character' | 'group';

interface SaveAttemptRecord {
  endpoint: SaveEndpointKind;
  ok: boolean;
  status?: number;
  errorMessage?: string;
}

interface SaveObservationScope {
  expectedChatId: string;
  expectedIdentity: string;
  records: SaveAttemptRecord[];
  pending: Promise<void>[];
}

const SAVE_CHAT_PATH = '/api/chats/save';
const SAVE_GROUP_CHAT_PATH = '/api/chats/group/save';
const OBSERVER_MARK = Symbol.for('st-baibai-tools.pen.chat-save-fetch-observer');

type MarkedFetch = typeof fetch & {
  [OBSERVER_MARK]?: true;
};

const activeScopes = new Set<SaveObservationScope>();

function normalizeChatKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\.jsonl$/i, '') : '';
}

function classifySaveEndpoint(input: RequestInfo | URL): SaveEndpointKind | null {
  let rawUrl = '';
  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.pathname;
  } else if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
    rawUrl = input.url;
  }
  if (!rawUrl) return null;

  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    pathname = rawUrl.split('?')[0] ?? rawUrl;
  }

  if (pathname === SAVE_CHAT_PATH || pathname.endsWith(SAVE_CHAT_PATH)) {
    return 'character';
  }
  if (pathname === SAVE_GROUP_CHAT_PATH || pathname.endsWith(SAVE_GROUP_CHAT_PATH)) {
    return 'group';
  }
  return null;
}

function extractRequestChatKey(endpoint: SaveEndpointKind, init?: RequestInit): string | null {
  const body = init?.body;
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as { file_name?: unknown; id?: unknown };
    if (endpoint === 'character') {
      return normalizeChatKey(parsed?.file_name) || null;
    }
    return normalizeChatKey(parsed?.id) || null;
  } catch {
    return null;
  }
}

function scopeMatchesRequest(
  scope: SaveObservationScope,
  requestChatKey: string | null,
  liveChatId: string,
  liveIdentity: string,
): boolean {
  if (requestChatKey !== null) {
    if (!scope.expectedChatId) return true;
    return requestChatKey === normalizeChatKey(scope.expectedChatId);
  }
  if (scope.expectedIdentity) {
    return liveIdentity === scope.expectedIdentity;
  }
  if (scope.expectedChatId) {
    return normalizeChatKey(liveChatId) === normalizeChatKey(scope.expectedChatId);
  }
  return true;
}

async function inspectSaveResponse(
  endpoint: SaveEndpointKind,
  response: Response,
): Promise<SaveAttemptRecord> {
  if (!response?.ok) {
    const status = typeof response?.status === 'number' ? response.status : undefined;
    return {
      endpoint,
      ok: false,
      status,
      errorMessage: status
        ? `聊天保存失败 (HTTP ${status})，修改未写入磁盘`
        : '聊天保存失败，修改未写入磁盘',
    };
  }

  let bodyOk = true;
  if (typeof response.clone === 'function') {
    try {
      const data = (await response.clone().json()) as { ok?: unknown } | null;
      if (data && typeof data === 'object' && 'ok' in data) {
        bodyOk = data.ok === true;
      }
    } catch {
      // 响应体为空或非 JSON 时沿用 HTTP 2xx 结果。
    }
  }

  return bodyOk
    ? { endpoint, ok: true, status: response.status }
    : {
        endpoint,
        ok: false,
        status: response.status,
        errorMessage: '聊天保存接口未确认成功（ok !== true），修改未写入磁盘',
      };
}

/**
 * 幂等单次包装 globalThis.fetch，仅在存在活跃保存观察窗口时旁路记录
 * `/api/chats/save` 与 `/api/chats/group/save` 的最终落盘状态，绝不消费原始响应流、
 * 也绝不在异步结束时卸载覆盖其他扩展包装器。
 */
export function ensureChatSaveFetchObserver(): void {
  const current = globalThis.fetch as MarkedFetch | undefined;
  if (typeof current !== 'function' || current[OBSERVER_MARK]) return;

  const underlying = current;
  const wrapped: MarkedFetch = function observedChatSaveFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (activeScopes.size === 0) {
      return underlying.call(this, input, init);
    }

    const endpoint = classifySaveEndpoint(input);
    if (!endpoint) {
      return underlying.call(this, input, init);
    }

    const requestChatKey = extractRequestChatKey(endpoint, init);
    const liveContext = getContext();
    const liveChatId = getOpenChatId(liveContext);
    const liveIdentity = getOpenChatIdentity(liveContext);
    const matchedScopes = [...activeScopes].filter(scope =>
      scopeMatchesRequest(scope, requestChatKey, liveChatId, liveIdentity),
    );

    const responsePromise = underlying.call(this, input, init);
    if (matchedScopes.length === 0) {
      return responsePromise;
    }

    const recordPromise = responsePromise.then(
      response => inspectSaveResponse(endpoint, response),
      error => ({
        endpoint,
        ok: false,
        errorMessage: `聊天保存请求异常（${error instanceof Error ? error.message : String(error)}），修改未写入磁盘`,
      }),
    );

    for (const scope of matchedScopes) {
      const tracker = recordPromise.then(record => {
        scope.records.push(record);
      });
      scope.pending.push(tracker);
    }

    return responsePromise;
  };

  wrapped[OBSERVER_MARK] = true;
  globalThis.fetch = wrapped;
}

const HOST_SAVE_FUNCTION_NAMES = new Set([
  'saveChatConditional',
  'saveChat',
  'saveGroupChat',
]);

export function expectsHttpChatPersistence(context: STContext | null): boolean {
  const fnName = context?.saveChat?.name ?? '';
  return HOST_SAVE_FUNCTION_NAMES.has(fnName);
}

export function assertChatPersistable(
  context: STContext | null,
  actionLabel = '保存修改',
): { chatId: string; chatIdentity: string } {
  if (!context) {
    throw new Error('SillyTavern 上下文不可用');
  }
  if (isChatStreaming(context)) {
    throw new Error(`当前正在生成回复，暂时无法${actionLabel}`);
  }

  const chatId = getOpenChatId(context);
  const chatIdentity = getOpenChatIdentity(context);

  if (typeof context.getCurrentChatId === 'function' && !chatId) {
    throw new Error(`当前聊天尚未创建存档文件，无法${actionLabel}`);
  }

  if (context.groupId && Array.isArray(context.groups)) {
    const matchedGroup = context.groups.find(group => String(group?.id) === String(context.groupId));
    if (!matchedGroup || !normalizeChatKey(matchedGroup.chat_id)) {
      throw new Error(`当前群聊缺少有效的聊天存档，无法${actionLabel}`);
    }
  } else if (
    !context.groupId &&
    Array.isArray(context.characters) &&
    context.characterId !== undefined &&
    context.characterId !== null &&
    context.characterId !== ''
  ) {
    const character = context.characters[Number(context.characterId)];
    if (character && 'chat' in character && !normalizeChatKey(character.chat)) {
      throw new Error(`当前聊天为临时会话或缺少存档文件名，无法${actionLabel}`);
    }
  }

  return { chatId, chatIdentity };
}

export interface VerifiedSaveOutcome<T> {
  value: T;
  observedHttpSave: boolean;
}

export async function runWithObservedChatSave<T>(
  options: {
    expectedChatId: string;
    expectedIdentity: string;
    requireHttpSave: boolean;
  },
  action: () => Promise<T>,
): Promise<VerifiedSaveOutcome<T>> {
  ensureChatSaveFetchObserver();
  const scope: SaveObservationScope = {
    expectedChatId: options.expectedChatId,
    expectedIdentity: options.expectedIdentity,
    records: [],
    pending: [],
  };
  activeScopes.add(scope);

  let value: T;
  try {
    value = await action();
    if (scope.pending.length > 0) {
      await Promise.allSettled(scope.pending);
    }
  } finally {
    activeScopes.delete(scope);
  }

  if (scope.records.length > 0) {
    const finalAttempt = scope.records[scope.records.length - 1];
    if (!finalAttempt.ok) {
      throw new Error(finalAttempt.errorMessage || '聊天保存失败，修改未写入磁盘');
    }
    return { value, observedHttpSave: true };
  }

  if (options.requireHttpSave) {
    throw new Error('聊天保存未完成（等待保存锁超时或未触发落盘请求），修改未写入磁盘');
  }

  if ((value as unknown) === false) {
    throw new Error('聊天保存失败，修改未写入磁盘');
  }

  return { value, observedHttpSave: false };
}
