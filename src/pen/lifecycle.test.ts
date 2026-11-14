import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pen/App.vue', () => ({ default: {} }));

import { bindEditButtons, unbindEditButtons } from '@pen/editButton';
import { removeStEventListener } from '@pen/st/context';
import { guardEditableArrowKeys } from '@pen/st/keyboard';
import { resetPenUiState, ui } from '@pen/state/ui';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removeStEventListener', () => {
  it('calls removeListener when off is absent on SillyTavern EventEmitter', () => {
    const removeListener = vi.fn();
    const handler = () => undefined;
    removeStEventListener(
      {
        removeListener,
        emit: async () => undefined,
      },
      'chat_id_changed',
      handler,
    );
    expect(removeListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('chat_id_changed', handler);
  });

  it('falls back to off when removeListener is unavailable', () => {
    const off = vi.fn();
    const handler = () => undefined;
    removeStEventListener(
      {
        off,
        emit: async () => undefined,
      },
      'chat_id_changed',
      handler,
    );
    expect(off).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('chat_id_changed', handler);
  });
});

describe('editButton rAF teardown & observer hygiene', () => {
  it('cancels queued requestAnimationFrame, avoids attributes:true observer storms, and prevents post-unbind insertion', () => {
    const queuedFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const cancelSpy = vi.fn((id: number) => {
      queuedFrames.delete(id);
    });
    let mutationCallback: (() => void) | null = null;
    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();

    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallback = cb;
      }
      observe = observeSpy;
      disconnect = disconnectSpy;
    }

    const insertedButtons: unknown[] = [];
    const topBar = {
      firstElementChild: null,
      querySelector: vi.fn(() => null),
      insertBefore: vi.fn((btn: unknown) => insertedButtons.push(btn)),
    };
    const mesElement = {
      getAttribute: () => '0',
      querySelector: vi.fn((sel: string) => {
        if (sel === '.mes_edit_buttons') return topBar;
        return null;
      }),
    };
    const editor = {
      value: '正文',
      closest: vi.fn(() => mesElement),
    };
    let editorActive = false;

    const fakeChat = {};
    const styleRemoved = vi.fn();
    const fakeStyleEl = { id: '', textContent: '', remove: styleRemoved };

    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++nextFrameId;
      queuedFrames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);
    vi.stubGlobal('window', {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      SillyTavern: {
        getContext: () => ({
          chat: [{ name: 'Char', is_user: false, is_system: false, mes: '正文' }],
        }),
      },
    });
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => (id === 'bby-message-rewrite-action-style' ? fakeStyleEl : null)),
      createElement: vi.fn(() => ({
        className: '',
        innerHTML: '',
        dataset: {},
        title: '',
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
        remove: vi.fn(),
      })),
      head: { append: vi.fn() },
      querySelector: vi.fn((sel: string) => {
        if (sel === '#chat') return fakeChat;
        if (sel === '#chat #curEditTextarea') return editorActive ? editor : null;
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
    });

    bindEditButtons();
    expect(mutationCallback).toBeTypeOf('function');
    expect(observeSpy).toHaveBeenCalledWith(fakeChat, { childList: true, subtree: true });

    // 打开编辑框触发一次 Mutation，排队 rAF 尚未执行时立即停用柏宝砚
    editorActive = true;
    mutationCallback!();
    expect(queuedFrames.size).toBe(1);

    // 抓取回调模拟极端情况下停用后仍被调用，验证 cancelAnimationFrame + bound 双重拦截
    const staleCallbacks = [...queuedFrames.values()];
    unbindEditButtons();

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(styleRemoved).toHaveBeenCalledOnce();

    for (const cb of staleCallbacks) {
      cb(16);
    }
    expect(insertedButtons).toHaveLength(0);
  });
});

describe('P-6：guardEditableArrowKeys 幂等注册与 resetPenUiState 重置', () => {
  it('accepts arbitrary EventTarget roots once via WeakSet without duplicate listener binding', () => {
    const addSpy = vi.fn();
    const fakeRoot = {
      addEventListener: addSpy,
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as EventTarget;

    guardEditableArrowKeys(fakeRoot);
    guardEditableArrowKeys(fakeRoot);
    expect(addSpy).toHaveBeenCalledOnce();
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('resetPenUiState clears active floor, chat identity, originalText, and paragraphs', () => {
    ui.open = true;
    ui.floor = 5;
    ui.floorLabel = '#5';
    ui.speaker = 'Alice';
    ui.originalText = '旧草稿';
    ui.chatId = 'chat-old';
    ui.chatIdentity = 'character:a.png\u0000chat-old';
    ui.paragraphs = [{ id: 1, text: '旧段落' }];

    resetPenUiState();
    expect(ui).toMatchObject({
      open: false,
      floor: null,
      floorLabel: '',
      speaker: '',
      originalText: '',
      chatId: '',
      chatIdentity: '',
      paragraphs: [],
    });
  });

  it('stopPen force-clears active chatSaveObserver scopes and restores globalThis.fetch when disabled', async () => {
    const { startPen, stopPen } = await import('@pen/index');
    const { runWithObservedChatSave } = await import('@pen/st/chatPersistence');
    const { hasFetchPipelineSlot } = await import('../features/fetchPipeline.js');

    const baseFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', baseFetch);
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.stubGlobal('window', {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      SillyTavern: {
        getContext: () => ({
          chat: [{ name: 'Alice', is_user: false, is_system: false, mes: '正文' }],
          characterId: 0,
          characters: [{ name: 'Alice', avatar: 'alice.png', chat: 'chat-a' }],
          extensionSettings: {},
          saveSettingsDebounced: vi.fn(),
          getCurrentChatId: () => 'chat-a',
          getRequestHeaders: () => ({}),
        }),
      },
    });
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({
        id: '',
        textContent: '',
        remove: vi.fn(),
      })),
      head: { append: vi.fn() },
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    });

    startPen();
    expect(globalThis.fetch).toBe(baseFetch);

    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => {
      releaseSave = resolve;
    });

    const pendingSave = runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: false,
      },
      async () => {
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(true);
        expect(globalThis.fetch).not.toBe(baseFetch);

        // 用户关闭新版楼层管理器开关 -> stopPen() 立即清退 chatSaveObserver 并恢复原始 fetch
        stopPen();
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);
        expect(globalThis.fetch).toBe(baseFetch);
        releaseSave();
      },
    );

    await pendingSave;
    expect(globalThis.fetch).toBe(baseFetch);
  });
});
