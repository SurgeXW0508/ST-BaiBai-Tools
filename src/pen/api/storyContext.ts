import {
  getCheckWorldInfo,
  getContext,
  getEjsTemplate,
  getOpenChatIdentity,
  isChatStreaming,
  type STExtensionPromptDescriptor,
  type STMessage,
  type WorldInfoEntry,
} from '@pen/st/context';

const HUGE_WORLD_INFO_CONTEXT = 1_000_000_000;
const AUTHOR_NOTE_EXTENSION_KEY = '2_floating_prompt';
const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';
const BOOK_SETTINGS_KEY = 'baibai_book';
const THINK_BLOCK =
  /<(?:think|thinking|thinging)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thinging)\s*>/gi;
const UNCLOSED_THINK_BLOCK = /<(?:think|thinking|thinging)\b[^>]*>[\s\S]*$/gi;
const NON_STORY_SYSTEM_TYPES = new Set([
  'help',
  'slash_commands',
  'formatting',
  'hotkeys',
  'macros',
  'welcome',
  'empty',
  'generic',
  'comment',
  'welcome_prompt',
  'assistant_note',
]);

export interface RewriteStoryContext {
  historyReference: string;
  latestUserMessage: string;
  worldInfo: string;
  charCard: string;
  persona: string;
  historyMessageCount: number;
}

export interface RewriteStoryContextOptions {
  includeWorldInfo: boolean;
  includeCharacterDescription: boolean;
  includeUserDescription: boolean;
}

const DEFAULT_REWRITE_STORY_CONTEXT_OPTIONS: RewriteStoryContextOptions = {
  includeWorldInfo: true,
  includeCharacterDescription: true,
  includeUserDescription: true,
};

export function cleanStoryContextText(message: string): string {
  let text = String(message ?? '')
    .replace(THINK_BLOCK, '')
    .replace(UNCLOSED_THINK_BLOCK, '')
    .replace(/<!--[\s\S]+?-->/g, '')
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, '');
  const starts = [...text.matchAll(/<bbs_start\b/gi)];
  const lastStart = starts.at(-1)?.index;
  if (lastStart !== undefined) text = text.slice(lastStart);
  const end = text.match(/<\/bbs_end>/i);
  if (end?.index !== undefined) text = text.slice(0, end.index + end[0].length);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isSystemUiMessage(message: STMessage): boolean {
  if (message.extra?.uses_system_ui === true) return true;
  const type = message.extra?.type;
  return typeof type === 'string' && NON_STORY_SYSTEM_TYPES.has(type.toLowerCase());
}

function isStoryUserMessage(message: STMessage | undefined): message is STMessage {
  return !!message && message.is_user && !isSystemUiMessage(message);
}

function isStoryAssistantMessage(message: STMessage | undefined): message is STMessage {
  if (!message || message.is_user || isSystemUiMessage(message)) return false;
  if (!message.is_system) return true;
  const name = (message.name ?? '').trim().toLowerCase();
  return name !== 'system' && name !== 'sillytavern system';
}

export function selectHistoryIndices(
  chat: STMessage[],
  floor: number,
  rounds: number,
): number[] {
  if (rounds <= 0 || floor <= 0) return [];
  const selected: number[] = [];
  let cursor = floor - 1;

  const skipNonStoryBackward = (start: number): number => {
    let index = start;
    while (index >= 0 && !isStoryUserMessage(chat[index]) && !isStoryAssistantMessage(chat[index])) {
      index -= 1;
    }
    return index;
  };

  for (let round = 0; round < rounds && cursor >= 0; round += 1) {
    cursor = skipNonStoryBackward(cursor);
    if (cursor < 0) break;

    if (isStoryAssistantMessage(chat[cursor])) {
      const roundIndices: number[] = [];
      while (cursor >= 0) {
        cursor = skipNonStoryBackward(cursor);
        if (cursor < 0 || !isStoryAssistantMessage(chat[cursor])) break;
        roundIndices.unshift(cursor);
        cursor -= 1;
      }
      cursor = skipNonStoryBackward(cursor);
      if (cursor >= 0 && isStoryUserMessage(chat[cursor])) {
        roundIndices.unshift(cursor);
        cursor -= 1;
      }
      selected.unshift(...roundIndices);
      continue;
    }

    const userIndex = cursor;
    cursor -= 1;
    const aiIndices: number[] = [];
    while (cursor >= 0) {
      cursor = skipNonStoryBackward(cursor);
      if (cursor < 0 || !isStoryAssistantMessage(chat[cursor])) break;
      aiIndices.unshift(cursor);
      cursor -= 1;
    }
    selected.unshift(...aiIndices, userIndex);
  }
  return selected;
}

export interface SerializedRewriteHistory {
  historyReference: string;
  latestUserMessage: string;
  messageCount: number;
}

export function serializeRewriteHistory(
  chat: STMessage[],
  indices: number[],
  userName: string,
  characterName: string,
  targetFloor?: number,
): SerializedRewriteHistory {
  const entries = indices
    .map(index => {
      const message = chat[index];
      const text = message ? cleanStoryContextText(message.mes) : '';
      return message && text ? { index, message, text } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const rewritingUserFloor = targetFloor !== undefined && Boolean(chat[targetFloor]?.is_user);
  const latest = entries.at(-1);
  const latestUser = !rewritingUserFloor && latest?.message.is_user ? latest : null;
  const referenceEntries = latestUser ? entries.slice(0, -1) : entries;
  const historyReference = referenceEntries
    .map(({ index, message, text }) => {
      const speaker = message.is_user
        ? message.name || userName || 'User'
        : message.name || characterName || 'Char';
      const hidden = message.is_system ? '｜ST 隐藏' : '';
      return `[楼层 #${index}｜${speaker}${hidden}]\n${text}`;
    })
    .join('\n\n');

  return {
    historyReference,
    latestUserMessage: latestUser?.text ?? '',
    messageCount: entries.length,
  };
}

function joinWorldInfoChunks(chunks: string[]): string {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const chunk of chunks) {
    const text = chunk?.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      output.push(text);
    }
  }
  return output.join('\n\n').trim();
}

interface BookWorldInfoSettings {
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  renderWorldInfoTemplates: boolean;
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

function bookWorldInfoSettings(): BookWorldInfoSettings {
  const extensionSettings = getContext()?.extensionSettings;
  const rawSharedExcludes = extensionSettings?.[SHARED_EXCLUDES_KEY];
  const sharedValue =
    rawSharedExcludes && typeof rawSharedExcludes === 'object'
      ? (rawSharedExcludes as {
          excludedWorldNames?: unknown;
          excludedWorldInfoPatterns?: unknown;
        })
      : null;

  const rawBook = extensionSettings?.[BOOK_SETTINGS_KEY];
  const bookValue =
    rawBook && typeof rawBook === 'object'
      ? (rawBook as {
          excludedWorldNames?: unknown;
          excludedWorldInfoPatterns?: unknown;
          renderWorldInfoTemplates?: unknown;
        })
      : {};

  return {
    excludedWorldNames:
      toStringArray(sharedValue?.excludedWorldNames) ??
      toStringArray(bookValue.excludedWorldNames) ??
      [],
    excludedWorldInfoPatterns:
      toStringArray(sharedValue?.excludedWorldInfoPatterns) ??
      toStringArray(bookValue.excludedWorldInfoPatterns) ??
      [],
    renderWorldInfoTemplates:
      typeof bookValue.renderWorldInfoTemplates === 'boolean'
        ? bookValue.renderWorldInfoTemplates
        : true,
  };
}

function isWorldInfoEntryExcluded(
  entry: WorldInfoEntry,
  settings: BookWorldInfoSettings,
): boolean {
  const world = entry.world?.trim();
  if (world && settings.excludedWorldNames.includes(world)) return true;
  const comment = entry.comment?.trim();
  if (!comment) return false;
  for (const raw of settings.excludedWorldInfoPatterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    try {
      if (new RegExp(pattern, 'i').test(comment)) return true;
    } catch {
      if (comment.toLowerCase().includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

async function renderWorldInfoContent(
  content: string,
  entry?: WorldInfoEntry,
  floor?: number,
): Promise<string> {
  if (!bookWorldInfoSettings().renderWorldInfoTemplates) return content;
  const context = getContext();
  let text =
    typeof context?.substituteParams === 'function'
      ? context.substituteParams(content)
      : content;
  if (!text.includes('<%')) return text;
  const ejs = getEjsTemplate();
  if (!ejs) return text;
  try {
    const environment = await ejs.prepareContext({ world_info: entry }, floor);
    const output = await ejs.evalTemplate(text, environment);
    if (typeof output === 'string') text = output;
  } catch (error) {
    console.log('[柏宝砚] 世界书 EJS 渲染失败，使用宏展开后的文本：', error);
  }
  return text;
}

function shouldRestoreAuthorNoteSlot(
  hadKey: boolean,
  previousRef: STExtensionPromptDescriptor | undefined,
  snapshot: STExtensionPromptDescriptor | undefined,
  currentRef: STExtensionPromptDescriptor | undefined,
  taskCompleted: boolean,
  taskResult: unknown,
): boolean {
  if (currentRef === previousRef) {
    if (!hadKey) return false;
    if (!previousRef || typeof previousRef !== 'object') return false;
    return previousRef.value !== snapshot?.value;
  }

  // checkWorldInfo 仅在返回前最后一步同步调用 setExtensionPrompt；若中途抛错，新对象必来自外部并发流程。
  if (!taskCompleted) return false;

  const resultRecord =
    taskResult && typeof taskResult === 'object'
      ? (taskResult as {
          ANBeforeEntries?: unknown;
          ANAfterEntries?: unknown;
          anBefore?: unknown;
          anAfter?: unknown;
        })
      : null;
  const rawAnTop = Array.isArray(resultRecord?.ANBeforeEntries)
    ? resultRecord.ANBeforeEntries
    : Array.isArray(resultRecord?.anBefore)
      ? resultRecord.anBefore
      : null;
  const rawAnBottom = Array.isArray(resultRecord?.ANAfterEntries)
    ? resultRecord.ANAfterEntries
    : Array.isArray(resultRecord?.anAfter)
      ? resultRecord.anAfter
      : null;

  if (rawAnTop !== null || rawAnBottom !== null) {
    const anTop = (rawAnTop ?? []).filter((item): item is string => typeof item === 'string');
    const anBottom = (rawAnBottom ?? []).filter((item): item is string => typeof item === 'string');
    const baseValue = typeof snapshot?.value === 'string' ? snapshot.value : '';
    const expectedDryRunValue = `${anTop.join('\n')}\n${baseValue}\n${anBottom.join('\n')}`.replace(
      /(^\n)|(\n$)/g,
      '',
    );
    return typeof currentRef?.value === 'string' && currentRef.value === expectedDryRunValue;
  }

  if (hadKey) {
    const baseValue = typeof snapshot?.value === 'string' ? snapshot.value : '';
    if (baseValue) {
      return typeof currentRef?.value === 'string' && currentRef.value.includes(baseValue);
    }
    return currentRef !== undefined;
  }

  return currentRef !== undefined;
}

/**
 * 酒馆 `checkWorldInfo(..., isDryRun=true)` 虽不持久化 sticky/cooldown，但命中 ANTop/ANBottom 条目时
 * 仍会调用 `setExtensionPrompt('2_floating_prompt', ...)` 改写当前会话的作者注释提示词槽位。
 * 干跑前不再预写临时占位对象；结束时仅在同聊天身份、非流式生成且槽位未被并发外部流程改写为无关新值时还原。
 */
async function withIsolatedAuthorNotePrompt<T>(task: () => Promise<T>): Promise<T> {
  const startContext = getContext();
  const prompts = startContext?.extensionPrompts;
  if (!prompts || typeof prompts !== 'object') {
    return task();
  }

  const startIdentity = getOpenChatIdentity(startContext);
  const hadKey = Object.prototype.hasOwnProperty.call(prompts, AUTHOR_NOTE_EXTENSION_KEY);
  const previousRef = prompts[AUTHOR_NOTE_EXTENSION_KEY];
  const snapshot: STExtensionPromptDescriptor | undefined =
    previousRef && typeof previousRef === 'object' ? { ...previousRef } : previousRef;

  let taskCompleted = false;
  let taskResult: unknown;
  try {
    const result = await task();
    taskCompleted = true;
    taskResult = result;
    return result;
  } finally {
    const liveContext = getContext();
    if (
      !isChatStreaming(liveContext) &&
      getOpenChatIdentity(liveContext) === startIdentity
    ) {
      const livePrompts = liveContext?.extensionPrompts;
      if (livePrompts === prompts) {
        const currentRef = livePrompts[AUTHOR_NOTE_EXTENSION_KEY];
        if (
          shouldRestoreAuthorNoteSlot(
            hadKey,
            previousRef,
            snapshot,
            currentRef,
            taskCompleted,
            taskResult,
          )
        ) {
          if (hadKey) {
            livePrompts[AUTHOR_NOTE_EXTENSION_KEY] =
              snapshot && typeof snapshot === 'object' ? { ...snapshot } : snapshot;
          } else {
            delete livePrompts[AUTHOR_NOTE_EXTENSION_KEY];
          }
        }
      }
    }
  }
}

async function fetchWorldInfoViaPrompt(scanText: string[], floor: number): Promise<string> {
  const context = getContext();
  if (isChatStreaming(context)) return '';
  const prompt = context?.getWorldInfoPrompt;
  if (typeof prompt !== 'function') return '';
  const result = await withIsolatedAuthorNotePrompt(() =>
    prompt(scanText, HUGE_WORLD_INFO_CONTEXT, true),
  );
  if (!result) return '';
  const chunks: string[] = [];
  if (typeof result.worldInfoBefore === 'string') chunks.push(result.worldInfoBefore);
  if (typeof result.worldInfoAfter === 'string') chunks.push(result.worldInfoAfter);
  for (const depth of result.worldInfoDepth ?? []) {
    for (const entry of depth.entries ?? []) if (typeof entry === 'string') chunks.push(entry);
  }
  for (const entry of result.anBefore ?? []) if (typeof entry === 'string') chunks.push(entry);
  for (const entry of result.anAfter ?? []) if (typeof entry === 'string') chunks.push(entry);
  return joinWorldInfoChunks(
    await Promise.all(chunks.map(chunk => renderWorldInfoContent(chunk, undefined, floor))),
  );
}

async function fetchWorldInfo(scanText: string[], floor: number): Promise<string> {
  if (!scanText.length) return '';
  if (isChatStreaming(getContext())) return '';
  try {
    const checkWorldInfo = await getCheckWorldInfo();
    if (isChatStreaming(getContext())) return '';
    if (!checkWorldInfo) return await fetchWorldInfoViaPrompt(scanText, floor);
    const result = await withIsolatedAuthorNotePrompt(() =>
      checkWorldInfo(scanText, HUGE_WORLD_INFO_CONTEXT, true),
    );
    const activated = result?.allActivatedEntries;
    if (!activated) return '';
    const entries = activated instanceof Map ? [...activated.values()] : [...activated];
    const settings = bookWorldInfoSettings();
    return joinWorldInfoChunks(
      await Promise.all(
        entries
          .filter(entry => entry && !isWorldInfoEntryExcluded(entry, settings))
          .map(entry =>
            renderWorldInfoContent(
              typeof entry.content === 'string' ? entry.content : '',
              entry,
              floor,
            ),
          ),
      ),
    );
  } catch (error) {
    console.log('[柏宝砚] 世界书激活失败，继续执行不带世界书的改写：', error);
    return '';
  }
}

function fetchCharCard(): string {
  const context = getContext();
  if (!context || context.groupId) return '';
  const characterId = context.characterId;
  if (characterId === undefined || characterId === null || characterId === '') return '';
  const character = context.characters?.[Number(characterId)];
  if (!character) return '';
  const substitute =
    typeof context.substituteParams === 'function'
      ? context.substituteParams
      : (value: string) => value;
  const fields: Array<[string, string]> = [
    ['描述', String(character.description ?? '')],
    ['性格', String(character.personality ?? '')],
    ['情景', String(character.scenario ?? '')],
  ];
  return fields
    .map(([label, raw]) => {
      const value = substitute(raw).trim();
      return value ? `【${label}】\n${value}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function fetchUserPersona(): string {
  const context = getContext();
  if (!context || typeof context.substituteParams !== 'function') return '';
  return context.substituteParams('{{persona}}').trim();
}

/**
 * 收集改写上下文。
 * 注意：酒馆 `checkWorldInfo(chat, ...)` 约定 `chat[0]` 为最新消息（depth = 0），
 * 因此 `scanText` 必须按「目标楼层 → 由近及远的历史楼层」逆序排列，并按真实说话人标注。
 */
export async function collectRewriteStoryContext(
  floor: number,
  currentText: string,
  contextRounds: number,
  options: RewriteStoryContextOptions = DEFAULT_REWRITE_STORY_CONTEXT_OPTIONS,
): Promise<RewriteStoryContext> {
  const context = getContext();
  if (!context) throw new Error('SillyTavern 上下文不可用');
  const indices = selectHistoryIndices(context.chat, floor, contextRounds);
  const history = serializeRewriteHistory(
    context.chat,
    indices,
    context.name1 || 'User',
    context.name2 || 'Char',
    floor,
  );

  const targetMessage = context.chat[floor];
  const targetSpeaker = targetMessage?.is_user
    ? targetMessage.name || context.name1 || 'User'
    : targetMessage?.name || context.name2 || 'Char';
  const cleanedTarget = cleanStoryContextText(currentText);

  const scanText = [
    cleanedTarget ? `${targetSpeaker}: ${cleanedTarget}` : '',
    ...[...indices].reverse().map(index => {
      const message = context.chat[index];
      if (!message) return '';
      const cleaned = cleanStoryContextText(message.mes);
      if (!cleaned) return '';
      const name = message.is_user
        ? message.name || context.name1 || 'User'
        : message.name || context.name2 || 'Char';
      return `${name}: ${cleaned}`;
    }),
  ].filter(Boolean);

  const worldInfo = options.includeWorldInfo
    ? await fetchWorldInfo(scanText, floor)
    : '';
  return {
    historyReference: history.historyReference,
    latestUserMessage: history.latestUserMessage,
    worldInfo,
    charCard: options.includeCharacterDescription ? fetchCharCard() : '',
    persona: options.includeUserDescription ? fetchUserPersona() : '',
    historyMessageCount: history.messageCount,
  };
}
