import {
  assertChatPersistable,
  expectsHttpChatPersistence,
  runWithObservedChatSave,
} from '@pen/st/chatPersistence';
import {
  getContext,
  getOpenChatId,
  getOpenChatIdentity,
  setMessageText,
  type STContext,
  type STMessage,
} from '@pen/st/context';
import { openPen } from '@pen/state/ui';

function findMessage(floor: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function activeEditorText(floor: number): string | null {
  return findMessage(floor)?.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value ?? null;
}

/**
 * 保存源自 ST 原生编辑框的改写时，先把最终文本同步回编辑框，再让 ST
 * 通过“取消编辑”流程收尾。此时 chat.mes 已经保存为新文本，所以取消按钮
 * 只负责重绘和清理内部编辑状态，不会撤销改写，也不会再次执行编辑正则。
 *
 * 旧版 ST 若没有取消按钮，则保留已同步的 textarea，交给用户随后正常完成；
 * 关键是不能调用 updateMessageBlock 提前删掉 textarea，否则 ST 会退回读取
 * 渲染后的 .mes_text.text()，导致 HTML、换行和空白丢失。
 */
function settleActiveEditor(floor: number, text: string): boolean {
  const message = findMessage(floor);
  const editor = message?.querySelector<HTMLTextAreaElement>('#curEditTextarea');
  if (!message || !editor) return false;

  editor.value = text;
  const cancelButton = message.querySelector<HTMLElement>('.mes_edit_cancel');
  if (!cancelButton) return true;
  cancelButton.click();
  return !message.querySelector('#curEditTextarea');
}

export function getFloorSourceText(floor: number): string | null {
  const message = getContext()?.chat?.[floor];
  if (!message) return null;
  return activeEditorText(floor) ?? message.mes ?? '';
}

/** 从楼层列表读取当前楼层源文本（若正处于 ST 原生编辑态则对齐编辑框文本），不要求该楼层已经渲染到 DOM。 */
export function openFloorInPen(floor: number): boolean {
  const context = getContext();
  const chatMessage = context?.chat?.[floor];
  if (!context || !chatMessage) return false;

  openPen(
    getFloorSourceText(floor) ?? chatMessage.mes ?? '',
    floor,
    chatMessage.name || (chatMessage.is_user ? '你' : 'AI'),
    getOpenChatId(context),
    getOpenChatIdentity(context),
  );
  return true;
}

export type ApplyFloorResult = 'saved' | 'chat-changed' | 'floor-changed' | 'unavailable';

async function emitMessageEvent(
  context: STContext,
  event: unknown,
  floor: number,
): Promise<void> {
  if (event !== undefined && context.eventSource?.emit) {
    await context.eventSource.emit(event, floor);
  }
}

async function refreshRenderedMessage(
  context: STContext,
  message: STMessage,
  floor: number,
): Promise<void> {
  const existing = findMessage(floor);
  if (!existing) return;

  if (typeof context.updateMessageBlock === 'function') {
    try {
      await context.updateMessageBlock(floor, message);
      return;
    } catch {
      // 局部刷新失败时回退到完整重载。
    }
  }

  try {
    await context.reloadCurrentChat?.();
  } catch (error) {
    console.warn('[柏宝砚] 楼层已保存，但界面刷新失败', error);
  }
}

function matchesExpectedTargetChat(
  context: STContext | null,
  expectedChatId: string,
  expectedChatIdentity: string,
): boolean {
  if (!context) return false;
  if (expectedChatIdentity) {
    return getOpenChatIdentity(context) === expectedChatIdentity;
  }
  if (expectedChatId) {
    return getOpenChatId(context) === expectedChatId;
  }
  return true;
}

/**
 * 直接更新聊天数组并核验持久化结果，不要求目标楼层存在于 DOM。
 * 若目标楼层恰好在 ST 编辑态，则以编辑区内容作为并发校验来源；
 * 落盘失败时原子回滚内存消息与当前 swipe，并抛错以便上层保留草稿供重试。
 */
export async function applyFloorText(
  floor: number,
  expectedText: string,
  nextText: string,
  expectedChatId = '',
  expectedChatIdentity = '',
): Promise<ApplyFloorResult> {
  const context = getContext();
  if (!context?.saveChat) return 'unavailable';
  if (!matchesExpectedTargetChat(context, expectedChatId, expectedChatIdentity)) {
    return 'chat-changed';
  }

  const message = context.chat?.[floor];
  if (!message) return 'unavailable';
  const editorText = activeEditorText(floor);
  if ((editorText ?? message.mes) !== expectedText) return 'floor-changed';

  const { chatId: activeChatId, chatIdentity: activeIdentity } = assertChatPersistable(
    context,
    '保存修改',
  );
  const lockChatId = expectedChatId || activeChatId;
  const lockIdentity = expectedChatIdentity || activeIdentity;

  const previousText = message.mes;
  const currentSwipe =
    Array.isArray(message.swipes)
      ? typeof message.swipe_id === 'number'
        ? message.swipe_id
        : 0
      : undefined;
  const previousSwipeText =
    currentSwipe !== undefined ? message.swipes?.[currentSwipe] : undefined;

  const rollbackMessage = () => {
    if (message.mes !== nextText) return;
    message.mes = previousText;
    if (
      currentSwipe !== undefined &&
      message.swipes &&
      currentSwipe >= 0 &&
      currentSwipe < message.swipes.length
    ) {
      message.swipes[currentSwipe] = previousSwipeText ?? previousText;
    }
  };

  setMessageText(message, nextText);

  let observedHttpSave = false;
  try {
    const saveChat = context.saveChat;
    const outcome = await runWithObservedChatSave(
      {
        expectedChatId: lockChatId,
        expectedIdentity: lockIdentity,
        requireHttpSave: expectsHttpChatPersistence(context),
      },
      () => saveChat(),
    );
    observedHttpSave = outcome.observedHttpSave;
  } catch (error) {
    rollbackMessage();
    throw error;
  }

  const postContext = getContext() ?? context;
  const stillSameChat =
    matchesExpectedTargetChat(postContext, lockChatId, lockIdentity) &&
    postContext.chat?.[floor] === message;

  // 若未观测到指向原聊天的成功 HTTP 落盘且等待期间聊天已切换，回滚原消息并按切聊中止。
  if (!stillSameChat) {
    if (!observedHttpSave) {
      rollbackMessage();
      return 'chat-changed';
    }
    return 'saved';
  }

  await emitMessageEvent(postContext, postContext.eventTypes?.MESSAGE_EDITED, floor).catch(error => {
    console.warn('[柏宝砚] 楼层已保存，但 MESSAGE_EDITED 事件发送失败', error);
  });
  if (!settleActiveEditor(floor, message.mes)) {
    await refreshRenderedMessage(postContext, message, floor);
    await emitMessageEvent(postContext, postContext.eventTypes?.MESSAGE_UPDATED, floor).catch(error => {
      console.warn('[柏宝砚] 楼层已保存，但 MESSAGE_UPDATED 事件发送失败', error);
    });
  }
  return 'saved';
}
