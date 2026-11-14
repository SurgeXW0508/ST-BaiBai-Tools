import {
  getContext,
  getOpenChatId,
  getOpenChatIdentity,
  isChatStreaming,
  type STContext,
  type STMessage,
} from '@pen/st/context';
import {
  hasFetchPipelineSlot,
  registerFetchPipelineSlot,
  unregisterFetchPipelineSlot,
  type FetchPipelineNext,
} from '../../features/fetchPipeline.js';

type SaveEndpointKind = 'character' | 'group';

export type BoundChatTarget =
  | {
      kind: 'character';
      avatarUrl: string;
      chName: string;
      fileName: string;
      identity: string;
      chatId: string;
      chatArrayRef: STMessage[];
    }
  | {
      kind: 'group';
      groupId: string;
      groupChatId: string;
      identity: string;
      chatId: string;
      chatArrayRef: STMessage[];
    };

type ParsedSaveRequestIdentity =
  | {
      endpoint: 'character';
      fileName: string;
      avatarUrl: string;
      chName: string;
    }
  | {
      endpoint: 'group';
      groupChatId: string;
    };

interface SaveAttemptRecord {
  endpoint: SaveEndpointKind;
  ok: boolean;
  status?: number;
  errorMessage?: string;
}

interface SaveObservationScope {
  target: BoundChatTarget;
  slots: Array<SaveAttemptRecord | null>;
  pending: Promise<void>[];
}

const SAVE_CHAT_PATH = '/api/chats/save';
const SAVE_GROUP_CHAT_PATH = '/api/chats/group/save';
const CHAT_SAVE_OBSERVER_SLOT = 'chatSaveObserver';

const activeScopes = new Set<SaveObservationScope>();

export function normalizeChatKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\.jsonl$/i, '') : '';
}

function parseIdentityDescriptor(identity: string): {
  kind: 'character' | 'group' | null;
  actorKey: string;
  chatId: string;
} {
  if (identity.startsWith('group:')) {
    const rest = identity.slice('group:'.length);
    const sep = rest.indexOf('\u0000');
    return sep >= 0
      ? { kind: 'group', actorKey: rest.slice(0, sep), chatId: rest.slice(sep + 1) }
      : { kind: 'group', actorKey: rest, chatId: '' };
  }
  if (identity.startsWith('character:')) {
    const rest = identity.slice('character:'.length);
    const sep = rest.indexOf('\u0000');
    return sep >= 0
      ? { kind: 'character', actorKey: rest.slice(0, sep), chatId: rest.slice(sep + 1) }
      : { kind: 'character', actorKey: rest, chatId: '' };
  }
  return { kind: null, actorKey: '', chatId: '' };
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

async function extractRequestIdentity(
  endpoint: SaveEndpointKind,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ParsedSaveRequestIdentity | null> {
  const rawText = await readRequestBodyText(input, init);
  if (!rawText || !rawText.trim()) return null;
  try {
    const parsed = JSON.parse(rawText) as {
      file_name?: unknown;
      avatar_url?: unknown;
      ch_name?: unknown;
      id?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') return null;

    if (endpoint === 'character') {
      const fileName = normalizeChatKey(parsed.file_name);
      if (!fileName) return null;
      return {
        endpoint: 'character',
        fileName,
        avatarUrl: typeof parsed.avatar_url === 'string' ? parsed.avatar_url.trim() : '',
        chName: typeof parsed.ch_name === 'string' ? parsed.ch_name.trim() : '',
      };
    }

    const groupChatId = normalizeChatKey(parsed.id);
    if (!groupChatId) return null;
    return {
      endpoint: 'group',
      groupChatId,
    };
  } catch {
    return null;
  }
}

function scopeMatchesRequest(
  target: BoundChatTarget,
  parsedRequest: ParsedSaveRequestIdentity | null,
): boolean {
  if (!parsedRequest) return false;

  if (parsedRequest.endpoint === 'character') {
    if (target.kind !== 'character') return false;
    if (!parsedRequest.fileName) return false;
    if (target.fileName && parsedRequest.fileName !== target.fileName) return false;
    if (target.avatarUrl) {
      return parsedRequest.avatarUrl === target.avatarUrl;
    }
    return true;
  }

  if (target.kind !== 'group') return false;
  if (!parsedRequest.groupChatId) return false;
  if (target.groupChatId && parsedRequest.groupChatId !== target.groupChatId) return false;
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

function observeChatSaveFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  nextFetch: FetchPipelineNext,
): Promise<Response> {
  if (activeScopes.size === 0) {
    return nextFetch(input, init);
  }

  const endpoint = classifySaveEndpoint(input);
  if (!endpoint) {
    return nextFetch(input, init);
  }

  const reservations = [...activeScopes].map(scope => {
    const slotIndex = scope.slots.length;
    scope.slots.push(null);
    return { scope, slotIndex };
  });

  // 同步调用底层 nextFetch 前按需提取异步 body Promise（对 Request 立即 clone，绝不阻塞 fetch 派发）
  const identityPromise = extractRequestIdentity(endpoint, input, init);
  const responsePromise = nextFetch(input, init);

  const recordPromise = responsePromise.then(
    response => inspectSaveResponse(endpoint, response),
    error => ({
      endpoint,
      ok: false,
      errorMessage: `聊天保存请求异常（${error instanceof Error ? error.message : String(error)}），修改未写入磁盘`,
    }),
  );

  const settleTask = Promise.all([identityPromise, recordPromise]).then(
    ([parsedRequest, record]) => {
      for (const { scope, slotIndex } of reservations) {
        if (scopeMatchesRequest(scope.target, parsedRequest)) {
          scope.slots[slotIndex] = record;
        }
      }
    },
  );

  for (const { scope } of reservations) {
    scope.pending.push(settleTask);
  }

  return responsePromise;
}

function syncChatSaveObserverSlot(): void {
  if (activeScopes.size > 0) {
    if (!hasFetchPipelineSlot(CHAT_SAVE_OBSERVER_SLOT)) {
      registerFetchPipelineSlot(CHAT_SAVE_OBSERVER_SLOT, observeChatSaveFetch);
    }
  } else {
    unregisterFetchPipelineSlot(CHAT_SAVE_OBSERVER_SLOT);
  }
}

/**
 * 同步 `/api/chats/save` 与 `/api/chats/group/save` 观察槽位生命周期：
 * 仅在存在活跃保存观察窗口（`activeScopes.size > 0`）时挂载到统一 `fetchPipeline`，
 * 空闲时自动卸载，保持零常驻拦截。
 */
export function ensureChatSaveFetchObserver(): void {
  syncChatSaveObserverSlot();
}

export function teardownChatSaveObserver(): void {
  activeScopes.clear();
  unregisterFetchPipelineSlot(CHAT_SAVE_OBSERVER_SLOT);
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

function buildBoundChatTargetFromContext(
  context: STContext | null,
  resolvedChatId: string,
  resolvedIdentity: string,
): BoundChatTarget {
  const parsedIdentity = parseIdentityDescriptor(resolvedIdentity);
  const chatArrayRef = Array.isArray(context?.chat) ? context.chat : [];

  if (context?.groupId || parsedIdentity.kind === 'group') {
    const groupId = String(context?.groupId || parsedIdentity.actorKey || '');
    const matchedGroup = Array.isArray(context?.groups)
      ? context.groups.find(group => String(group?.id) === groupId)
      : undefined;
    const groupChatId = normalizeChatKey(
      matchedGroup?.chat_id || resolvedChatId || parsedIdentity.chatId,
    );
    return {
      kind: 'group',
      groupId,
      groupChatId,
      identity: resolvedIdentity,
      chatId: resolvedChatId || parsedIdentity.chatId,
      chatArrayRef,
    };
  }

  const hasCharacterIndex =
    context?.characterId !== undefined &&
    context?.characterId !== null &&
    context?.characterId !== '';
  const character = hasCharacterIndex
    ? context?.characters?.[Number(context.characterId)]
    : undefined;
  const characterAvatar = typeof character?.avatar === 'string' ? character.avatar.trim() : '';
  const fallbackIdentityAvatar =
    !characterAvatar &&
    parsedIdentity.kind === 'character' &&
    parsedIdentity.actorKey &&
    (!hasCharacterIndex || parsedIdentity.actorKey !== String(context?.characterId))
      ? parsedIdentity.actorKey.trim()
      : '';
  const avatarUrl = characterAvatar || fallbackIdentityAvatar;
  const chName = typeof character?.name === 'string' ? character.name.trim() : '';
  const fileName = normalizeChatKey(character?.chat || resolvedChatId || parsedIdentity.chatId);

  return {
    kind: 'character',
    avatarUrl,
    chName,
    fileName,
    identity: resolvedIdentity,
    chatId: resolvedChatId || parsedIdentity.chatId,
    chatArrayRef,
  };
}

export function resolveBoundChatTarget(
  context: STContext | null,
  expectedChatId = '',
  expectedIdentity = '',
  actionLabel = '保存修改',
): BoundChatTarget {
  const { chatId: activeChatId, chatIdentity: activeIdentity } = assertChatPersistable(
    context,
    actionLabel,
  );
  const resolvedChatId = expectedChatId || activeChatId;
  const resolvedIdentity = expectedIdentity || activeIdentity;
  return buildBoundChatTargetFromContext(context, resolvedChatId, resolvedIdentity);
}

export function isTargetStillActive(
  target: BoundChatTarget,
  liveContext: STContext | null = getContext(),
): liveContext is STContext {
  if (!liveContext) return false;
  if (liveContext.chat !== target.chatArrayRef) return false;
  if (target.identity) {
    return getOpenChatIdentity(liveContext) === target.identity;
  }
  if (target.chatId) {
    return normalizeChatKey(getOpenChatId(liveContext)) === normalizeChatKey(target.chatId);
  }
  return Boolean(liveContext.groupId) === (target.kind === 'group');
}

export interface VerifiedSaveOutcome<T> {
  value: T;
  observedHttpSave: boolean;
}

export async function runWithObservedChatSave<T>(
  options: {
    target?: BoundChatTarget;
    expectedChatId?: string;
    expectedIdentity?: string;
    requireHttpSave: boolean;
  },
  action: () => Promise<T>,
): Promise<VerifiedSaveOutcome<T>> {
  const target =
    options.target ??
    buildBoundChatTargetFromContext(
      getContext(),
      options.expectedChatId ?? '',
      options.expectedIdentity ?? '',
    );

  const scope: SaveObservationScope = {
    target,
    slots: [],
    pending: [],
  };
  activeScopes.add(scope);
  syncChatSaveObserverSlot();

  let value: T;
  try {
    value = await action();
    if (scope.pending.length > 0) {
      await Promise.allSettled(scope.pending);
    }
  } finally {
    activeScopes.delete(scope);
    syncChatSaveObserverSlot();
  }

  if ((value as unknown) === false) {
    throw new Error('聊天保存未完成（当前会话已切换或未写入磁盘），修改未写入磁盘');
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

  return { value, observedHttpSave: false };
}
