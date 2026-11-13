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

export interface DeleteFloorsResult {
  deletedCount: number;
  effectiveStartFloor: number;
}

interface DeleteTargetSnapshot {
  chatId: string;
  chatIdentity: string;
  chatArrayRef: STMessage[];
  requestedFloor: number;
  effectiveFloor: number;
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

/**
 * 对齐酒馆原生 `getMessageDeletionStartId`：
 * 若目标为普通 AI 回复楼层，向前纳入紧邻的隐藏 `extra.tool_invocations` 工具调用载体楼层，
 * 再以 `/del toolcalls=false N` 精确删除 `[effectiveFloor .. endFloor]`，避免漏删孤立工具记录或二次隐式连带。
 */
export function resolveEffectiveDeleteStartFloor(chat: STMessage[], floor: number): number {
  const target = chat[floor];
  if (!target || target.is_user || target.is_system) {
    return floor;
  }
  let start = floor;
  while (start > 0) {
    const previous = chat[start - 1];
    const toolInvocations = (previous?.extra as { tool_invocations?: unknown } | undefined)
      ?.tool_invocations;
    if (previous?.is_system && Array.isArray(toolInvocations)) {
      start -= 1;
    } else {
      break;
    }
  }
  return start;
}

/**
 * 在执行 `/hide`、`/unhide` 或 `/del` 前检查酒馆原生 `#curEditTextarea`：
 * - 若存在未保存手改，拒绝执行并提示用户先完成或取消原生编辑；
 * - 若未改动，先点击 `.mes_edit_cancel` 干净收起编辑框（`/del` 内部 `doMesCut` 会覆盖全局 `this_edit_mes_id`）。
 */
function prepareNativeEditorsBeforeSlashAction(
  context: STContext,
  scopeFloor: 'any' | number,
): void {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return;
  }
  const messageNodes = Array.from(document.querySelectorAll<HTMLElement>('#chat .mes'));
  for (const mesNode of messageNodes) {
    const editor = mesNode.querySelector<HTMLTextAreaElement>('#curEditTextarea');
    if (!editor) continue;

    const rawId = mesNode.getAttribute('mesid');
    const mesId = rawId !== null && rawId !== '' ? Number(rawId) : Number.NaN;
    if (scopeFloor !== 'any' && mesId !== scopeFloor) continue;

    const storedText = String(context.chat?.[mesId]?.mes ?? '');
    const editorText = editor.value;
    if (
      !Number.isInteger(mesId) ||
      (editorText !== storedText && editorText !== storedText.trim())
    ) {
      const label = Number.isInteger(mesId) ? `#${mesId}` : '当前';
      throw new Error(`第 ${label} 层正在酒馆原生编辑框中修改且未保存，请先完成或取消该层编辑`);
    }

    const cancelButton = mesNode.querySelector<HTMLElement>('.mes_edit_cancel');
    cancelButton?.click();
    if (mesNode.querySelector('#curEditTextarea')) {
      throw new Error(`第 #${mesId} 层的酒馆原生编辑框无法自动关闭，请先手动取消该层编辑`);
    }
  }
}

function captureDeleteSnapshot(context: STContext, floor: number): DeleteTargetSnapshot {
  const chat = context.chat;
  const effectiveFloor = resolveEffectiveDeleteStartFloor(chat, floor);
  const deleteCount = chat.length - effectiveFloor;
  return {
    chatId: getOpenChatId(context),
    chatIdentity: getOpenChatIdentity(context),
    chatArrayRef: chat,
    requestedFloor: floor,
    effectiveFloor,
    endFloor: chat.length - 1,
    chatLength: chat.length,
    deleteCount,
    sliceEntries: chat.slice(effectiveFloor).map(message => ({
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
  if (resolveEffectiveDeleteStartFloor(chat, snapshot.requestedFloor) !== snapshot.effectiveFloor) {
    return false;
  }
  for (let offset = 0; offset < snapshot.sliceEntries.length; offset += 1) {
    const current = chat[snapshot.effectiveFloor + offset];
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

function formatDeleteRangeLabel(snapshot: DeleteTargetSnapshot): string {
  const baseLabel =
    snapshot.deleteCount === 1
      ? `第 ${snapshot.effectiveFloor} 层（共 1 条）`
      : `第 ${snapshot.effectiveFloor} 至 #${snapshot.endFloor} 层（共 ${snapshot.deleteCount} 条）`;
  if (snapshot.effectiveFloor < snapshot.requestedFloor) {
    return `${baseLabel}，含第 #${snapshot.requestedFloor} 层前置关联工具调用记录`;
  }
  return baseLabel;
}

function formatInitialDeletePrompt(snapshot: DeleteTargetSnapshot): string {
  return `将删除${formatDeleteRangeLabel(snapshot)}，删除后无法撤销。确定继续吗？`;
}

function formatChangedRangeDeletePrompt(snapshot: DeleteTargetSnapshot): string {
  return `确认期间当前聊天的楼层内容或数量已变动，目标已更新为${formatDeleteRangeLabel(snapshot)}。仍要删除吗？`;
}

/** 用 ST 的 /hide、/unhide 斜杠命令切换单层的隐藏状态（is_system）。返回切换后是否隐藏。 */
export async function toggleFloorHidden(floor: number): Promise<boolean> {
  const context = getContext();
  const message = context?.chat?.[floor];
  if (!context || !message) throw new Error('楼层不存在');

  const { chatId, chatIdentity } = assertChatPersistable(context, '切换楼层隐藏状态');
  const run = requireSlashRunner(context);
  prepareNativeEditorsBeforeSlashAction(context, floor);
  const willHide = !message.is_system;

  let slashInvoked = false;
  let result: Awaited<ReturnType<SlashRunner>>;
  try {
    const outcome = await runWithObservedChatSave(
      {
        expectedChatId: chatId,
        expectedIdentity: chatIdentity,
        requireHttpSave: expectsHttpChatPersistence(context),
      },
      () => {
        slashInvoked = true;
        return run(willHide ? `/hide ${floor}` : `/unhide ${floor}`, {
          handleExecutionErrors: true,
          source: SLASH_SOURCE,
        });
      },
    );
    result = outcome.value;
  } catch (error) {
    if (slashInvoked) {
      await (getContext() ?? context)?.reloadCurrentChat?.().catch(() => {});
    }
    throw error;
  }

  if (result?.isError) {
    throw new Error(result.errorMessage || '斜杠命令执行失败');
  }

  const postContext = getContext() ?? context;
  if (Boolean(postContext.chat?.[floor]?.is_system) !== willHide) {
    throw new Error('楼层隐藏状态未生效，请刷新聊天后重试');
  }
  return willHide;
}

/**
 * 删除第 floor 层及之后的所有楼层（对齐 ST /del 语义，并纳入紧邻的前置 tool_invocations 载体层）。
 * 确认前快照当前聊天身份与待删楼层区间；确认返回后强制二次核验：
 * - 若已切聊或启动生成则立即中止，绝不在新聊天上执行 `/del`；
 * - 若同一聊天内楼层数量或内容发生变化，提示新范围并要求重新确认；
 * 返回实际删除数量与有效起始楼层，用户取消时 deletedCount 为 0。
 */
export async function deleteFloorsFrom(floor: number): Promise<DeleteFloorsResult> {
  const initialContext = getContext();
  const initialChat = initialContext?.chat;
  if (!initialContext || !initialChat?.[floor]) throw new Error('楼层不存在');

  assertChatPersistable(initialContext, '删除楼层');
  requireSlashRunner(initialContext);

  let snapshot = captureDeleteSnapshot(initialContext, floor);
  if (snapshot.deleteCount < 1) {
    return { deletedCount: 0, effectiveStartFloor: snapshot.effectiveFloor };
  }

  for (let attempt = 0; attempt <= MAX_DELETE_RECONFIRM_ATTEMPTS; attempt += 1) {
    const promptContext = getContext() ?? initialContext;
    const promptMessage =
      attempt === 0
        ? formatInitialDeletePrompt(snapshot)
        : formatChangedRangeDeletePrompt(snapshot);
    const confirmed = await confirmPopup(promptContext, promptMessage);
    if (!confirmed) {
      return { deletedCount: 0, effectiveStartFloor: snapshot.effectiveFloor };
    }

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
      prepareNativeEditorsBeforeSlashAction(liveContext, 'any');

      let slashInvoked = false;
      let result: Awaited<ReturnType<SlashRunner>>;
      try {
        const outcome = await runWithObservedChatSave(
          {
            expectedChatId: snapshot.chatId,
            expectedIdentity: snapshot.chatIdentity,
            requireHttpSave: expectsHttpChatPersistence(liveContext),
          },
          () => {
            slashInvoked = true;
            return run(`/del toolcalls=false ${snapshot.deleteCount}`, {
              handleExecutionErrors: true,
              source: SLASH_SOURCE,
            });
          },
        );
        result = outcome.value;
      } catch (error) {
        if (slashInvoked) {
          await (getContext() ?? liveContext)?.reloadCurrentChat?.().catch(() => {});
        }
        throw error;
      }

      if (result?.isError) {
        throw new Error(result.errorMessage || '斜杠删除命令执行失败');
      }

      const postContext = getContext() ?? liveContext;
      if (postContext.chat?.length !== snapshot.effectiveFloor) {
        throw new Error(
          `楼层删除结果异常（预期剩余 ${snapshot.effectiveFloor} 层，实际 ${postContext.chat?.length ?? 0} 层）`,
        );
      }

      return {
        deletedCount: snapshot.deleteCount,
        effectiveStartFloor: snapshot.effectiveFloor,
      };
    }

    if (attempt === MAX_DELETE_RECONFIRM_ATTEMPTS) {
      throw new Error('聊天楼层持续变动，已取消删除，请稍后重试');
    }
    snapshot = captureDeleteSnapshot(liveContext, floor);
  }

  return { deletedCount: 0, effectiveStartFloor: snapshot.effectiveFloor };
}
