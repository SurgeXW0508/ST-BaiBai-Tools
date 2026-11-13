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
  slots: Array<SaveAttemptRecord | null>;
  pending: Promise<void>[];
}

const SAVE_CHAT_PATH = '/api/chats/save';
const SAVE_GROUP_CHAT_PATH = '/api/chats/group/save';
const OBSERVER_MARK = Symbol.for('st-baibai-tools.pen.chat-save-fetch-observer');
const UNDERLYING_FETCH = Symbol.for('st-baibai-tools.pen.chat-save-underlying-fetch');

type MarkedFetch = typeof fetch & {
  [OBSERVER_MARK]?: true;
  [UNDERLYING_FETCH]?: typeof fetch;
  __penUnderlyingFetch?: typeof fetch;
  __baiBaiToolkitOriginalFetch?: typeof fetch;
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

function hasGzipContentEncoding(input: RequestInfo | URL, init?: RequestInit): boolean {
  try {
    const rawHeaders =
      init?.headers ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
    if (!rawHeaders) return false;
    const headers = rawHeaders instanceof Headers ? rawHeaders : new Headers(rawHeaders);
    const encoding = headers.get('content-encoding') ?? '';
    return /\bgzip\b/i.test(encoding);
  } catch {
    return false;
  }
}

async function decodeBytesToText(bytes: Uint8Array, gzipped: boolean): Promise<string | null> {
  if (bytes.byteLength === 0) return null;
  if (gzipped) {
    if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') {
      return null;
    }
    try {
      const stream = new Blob([bytes as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch {
      return null;
    }
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function readRequestBodyText(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | null> {
  const gzipped = hasGzipContentEncoding(input, init);
  const body = init?.body;

  if (typeof body === 'string') {
    return body;
  }

  if (body !== undefined && body !== null) {
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      return decodeBytesToText(new Uint8Array(body), gzipped);
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      return decodeBytesToText(view, gzipped);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size === 0) return null;
      if (!gzipped && typeof body.text === 'function') {
        try {
          return await body.text();
        } catch {
          return null;
        }
      }
      try {
        const buffer = await body.arrayBuffer();
        return decodeBytesToText(new Uint8Array(buffer), gzipped);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (typeof Request !== 'undefined' && input instanceof Request && !input.bodyUsed) {
    try {
      const cloned = input.clone();
      if (!gzipped) {
        return await cloned.text();
      }
      const buffer = await cloned.arrayBuffer();
      return decodeBytesToText(new Uint8Array(buffer), true);
    } catch {
      return null;
    }
  }

  return null;
}

async function extractRequestChatKey(
  endpoint: SaveEndpointKind,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | null> {
  const rawText = await readRequestBodyText(input, init);
  if (!rawText || !rawText.trim()) return null;
  try {
    const parsed = JSON.parse(rawText) as { file_name?: unknown; id?: unknown };
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

function isObserverInFetchChain(candidate: unknown): boolean {
  const visited = new Set<unknown>();
  let current = candidate as MarkedFetch | undefined;
  while (typeof current === 'function' && !visited.has(current)) {
    if (current[OBSERVER_MARK]) return true;
    visited.add(current);
    current =
      current.__baiBaiToolkitOriginalFetch ??
      current[UNDERLYING_FETCH] ??
      current.__penUnderlyingFetch;
  }
  return false;
}

/**
 * 幂等单次包装 globalThis.fetch，仅在存在活跃保存观察窗口时旁路记录
 * `/api/chats/save` 与 `/api/chats/group/save` 的最终落盘状态，绝不延迟底层 fetch 发起、
 * 绝不消费原始响应流，也绝不在外层存在其他包装器时重复挂载第二层。
 */
export function ensureChatSaveFetchObserver(): void {
  const current = globalThis.fetch as MarkedFetch | undefined;
  if (typeof current !== 'function' || isObserverInFetchChain(current)) return;

  const hookState = {
    rawOriginalFetch: current,
    originalFetch: current.bind(globalThis),
  };
  const wrapped: MarkedFetch & { __baiBaiToolkitHookState?: typeof hookState } =
    function observedChatSaveFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const targetFetch = wrapped.__baiBaiToolkitOriginalFetch ?? hookState.rawOriginalFetch;
      if (activeScopes.size === 0) {
        return targetFetch.call(this, input, init);
      }

      const endpoint = classifySaveEndpoint(input);
      if (!endpoint) {
        return targetFetch.call(this, input, init);
      }

      const liveContextAtDispatch = getContext();
      const liveChatIdAtDispatch = getOpenChatId(liveContextAtDispatch);
      const liveIdentityAtDispatch = getOpenChatIdentity(liveContextAtDispatch);
      const reservations = [...activeScopes].map(scope => {
        const slotIndex = scope.slots.length;
        scope.slots.push(null);
        return { scope, slotIndex };
      });

      // 同步调用底层 fetch 前按需提取异步 body Promise（对 Request 立即 clone，绝不阻塞 fetch 派发）
      const chatKeyPromise = extractRequestChatKey(endpoint, input, init);
      const responsePromise = targetFetch.call(this, input, init);

      const recordPromise = responsePromise.then(
        response => inspectSaveResponse(endpoint, response),
        error => ({
          endpoint,
          ok: false,
          errorMessage: `聊天保存请求异常（${error instanceof Error ? error.message : String(error)}），修改未写入磁盘`,
        }),
      );

      const settleTask = Promise.all([chatKeyPromise, recordPromise]).then(
        ([requestChatKey, record]) => {
          for (const { scope, slotIndex } of reservations) {
            if (
              scopeMatchesRequest(
                scope,
                requestChatKey,
                liveChatIdAtDispatch,
                liveIdentityAtDispatch,
              )
            ) {
              scope.slots[slotIndex] = record;
            }
          }
        },
      );

      for (const { scope } of reservations) {
        scope.pending.push(settleTask);
      }

      return responsePromise;
    };

  wrapped[OBSERVER_MARK] = true;
  wrapped[UNDERLYING_FETCH] = current;
  wrapped.__penUnderlyingFetch = current;
  wrapped.__baiBaiToolkitOriginalFetch = current;
  wrapped.__baiBaiToolkitHookState = hookState;
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
    slots: [],
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

  const matchedRecords = scope.slots.filter((item): item is SaveAttemptRecord => item !== null);
  if (matchedRecords.length > 0) {
    const finalAttempt = matchedRecords[matchedRecords.length - 1];
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
