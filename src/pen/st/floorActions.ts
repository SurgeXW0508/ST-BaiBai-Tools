import {
  assertChatPersistable,
  expectsHttpChatPersistence,
  runWithObservedChatSave,
} from '@pen/st/chatPersistence';
import {
  getContext,
  getOpenChatId,
  getOpenChatIdentity,
  isChatStreaming,
  type STContext,
  type STMessage,
} from '@pen/st/context';

const SLASH_SOURCE = 'baibai-pen';
const MAX_DELETE_RECONFIRM_ATTEMPTS = 2;

type SlashRunner = NonNullable<STContext['executeSlashCommandsWithOptions']>;

interface DeleteTargetSnapshot {
  chatId: string;
  chatIdentity: string;
  chatArrayRef: STMessage[];
  floor: number;
  endFloor: number;
  chatLength: number;
  deleteCount: number;
  sliceEntries: Array<{
    ref: STMessage;
    mes: string;
    isUser: boolean;
  }>;
}

function requireSlashRunner(context: STContext | null): SlashRunner {
  const run = context?.executeSlashCommandsWithOptions;
  if (typeof run !== 'function') {
    throw new Error('当前酒馆版本未暴露斜杠命令执行接口');
  }
  return run;
}

function captureDeleteSnapshot(context: STContext, floor: number): DeleteTargetSnapshot {
  const chat = context.chat;
  const deleteCount = chat.length - floor;
  return {
    chatId: getOpenChatId(context),
    chatIdentity: getOpenChatIdentity(context),
    chatArrayRef: chat,
    floor,
    endFloor: chat.length - 1,
    chatLength: chat.length,
    deleteCount,
    sliceEntries: chat.slice(floor).map(message => ({
      ref: message,
      mes: message.mes ?? '',
      isUser: Boolean(message.is_user),
    })),
  };
}

function isSameChatTarget(liveContext: STContext, snapshot: DeleteTargetSnapshot): boolean {
  if (snapshot.chatIdentity) {
    return getOpenChatIdentity(liveContext) === snapshot.chatIdentity;
  }
  if (snapshot.chatId) {
    return getOpenChatId(liveContext) === snapshot.chatId;
  }
  return liveContext.chat === snapshot.chatArrayRef;
}

function isSliceUnchanged(liveContext: STContext, snapshot: DeleteTargetSnapshot): boolean {
  const chat = liveContext.chat;
  if (!Array.isArray(chat) || chat.length !== snapshot.chatLength) return false;
  for (let offset = 0; offset < snapshot.sliceEntries.length; offset += 1) {
    const current = chat[snapshot.floor + offset];
    const expected = snapshot.sliceEntries[offset];
    if (!current || !expected) return false;
    if (
      current !== expected.ref ||
      (current.mes ?? '') !== expected.mes ||
      Boolean(current.is_user) !== expected.isUser
    ) {
      return false;
    }
  }
  return true;
}

async function confirmPopup(context: STContext, message: string): Promise<boolean> {
  if (
    typeof context.callGenericPopup === 'function' &&
    context.POPUP_TYPE &&
    'CONFIRM' in context.POPUP_TYPE
  ) {
    return Boolean(await context.callGenericPopup(message, context.POPUP_TYPE.CONFIRM));
  }
  return Boolean(globalThis.confirm?.(message));
}

function formatInitialDeletePrompt(snapshot: DeleteTargetSnapshot): string {
  const rangeLabel =
    snapshot.deleteCount === 1
      ? `第 ${snapshot.floor} 层（共 1 条）`
      : `第 ${snapshot.floor} 至 #${snapshot.endFloor} 层（共 ${snapshot.deleteCount} 条）`;
  return `将删除${rangeLabel}，删除后无法撤销。确定继续吗？`;
}

function formatChangedRangeDeletePrompt(snapshot: DeleteTargetSnapshot): string {
  const rangeLabel =
    snapshot.deleteCount === 1
      ? `第 ${snapshot.floor} 层（共 1 条）`
      : `第 ${snapshot.floor} 至 #${snapshot.endFloor} 层（共 ${snapshot.deleteCount} 条）`;
  return `确认期间当前聊天的楼层内容或数量已变动，目标已更新为${rangeLabel}。仍要删除吗？`;
}

/** 用 ST 的 /hide、/unhide 斜杠命令切换单层的隐藏状态（is_system）。返回切换后是否隐藏。 */
export async function toggleFloorHidden(floor: number): Promise<boolean> {
  const context = getContext();
  const message = context?.chat?.[floor];
  if (!context || !message) throw new Error('楼层不存在');

  const { chatId, chatIdentity } = assertChatPersistable(context, '切换楼层隐藏状态');
  const run = requireSlashRunner(context);
  const willHide = !message.is_system;

  const { value: result } = await runWithObservedChatSave(
    {
      expectedChatId: chatId,
      expectedIdentity: chatIdentity,
      requireHttpSave: expectsHttpChatPersistence(context),
    },
    () =>
      run(willHide ? `/hide ${floor}` : `/unhide ${floor}`, {
        handleExecutionErrors: true,
        source: SLASH_SOURCE,
      }),
  );

  if (result?.isError) {
    throw new Error(result.errorMessage || '斜杠命令执行失败');
  }
  return willHide;
}

/**
 * 删除第 floor 层及之后的所有楼层（对齐 ST /del 语义：从末尾删 N 条）。
 * 确认前快照当前聊天身份与待删楼层区间；确认返回后强制二次核验：
 * - 若已切聊或启动生成则立即中止，绝不在新聊天上执行 `/del`；
 * - 若同一聊天内楼层数量或内容发生变化，提示新范围并要求重新确认；
 * 返回删除数量，用户取消时返回 0。
 */
export async function deleteFloorsFrom(floor: number): Promise<number> {
  const initialContext = getContext();
  const initialChat = initialContext?.chat;
  if (!initialContext || !initialChat?.[floor]) throw new Error('楼层不存在');

  assertChatPersistable(initialContext, '删除楼层');
  requireSlashRunner(initialContext);

  let snapshot = captureDeleteSnapshot(initialContext, floor);
  if (snapshot.deleteCount < 1) return 0;

  for (let attempt = 0; attempt <= MAX_DELETE_RECONFIRM_ATTEMPTS; attempt += 1) {
    const promptContext = getContext() ?? initialContext;
    const promptMessage =
      attempt === 0
        ? formatInitialDeletePrompt(snapshot)
        : formatChangedRangeDeletePrompt(snapshot);
    const confirmed = await confirmPopup(promptContext, promptMessage);
    if (!confirmed) return 0;

    const liveContext = getContext();
    if (!liveContext) {
      throw new Error('SillyTavern 上下文不可用，已取消删除');
    }
    if (!isSameChatTarget(liveContext, snapshot)) {
      throw new Error('确认期间当前聊天已切换，已取消删除');
    }
    if (isChatStreaming(liveContext)) {
      throw new Error('确认期间已开始生成回复，已取消删除');
    }
    if (!liveContext.chat?.[floor] || liveContext.chat.length <= floor) {
      throw new Error('目标楼层在确认期间已被移除，已取消删除');
    }

    if (isSliceUnchanged(liveContext, snapshot)) {
      const run = requireSlashRunner(liveContext);
      const { value: result } = await runWithObservedChatSave(
        {
          expectedChatId: snapshot.chatId,
          expectedIdentity: snapshot.chatIdentity,
          requireHttpSave: expectsHttpChatPersistence(liveContext),
        },
        () =>
          run(`/del ${snapshot.deleteCount}`, {
            handleExecutionErrors: true,
            source: SLASH_SOURCE,
          }),
      );

      if (result?.isError) {
        throw new Error(result.errorMessage || '斜杠删除命令执行失败');
      }
      return snapshot.deleteCount;
    }

    if (attempt === MAX_DELETE_RECONFIRM_ATTEMPTS) {
      throw new Error('聊天楼层持续变动，已取消删除，请稍后重试');
    }
    snapshot = captureDeleteSnapshot(liveContext, floor);
  }

  return 0;
}
