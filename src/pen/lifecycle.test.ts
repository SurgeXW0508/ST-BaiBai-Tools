import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindEditButtons, unbindEditButtons } from '@pen/editButton';
import { removeStEventListener } from '@pen/st/context';

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

describe('editButton rAF teardown', () => {
  it('cancels queued requestAnimationFrame and prevents post-unbind button insertion', () => {
    const queuedFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const cancelSpy = vi.fn((id: number) => {
      queuedFrames.delete(id);
    });
    let mutationCallback: (() => void) | null = null;
    const disconnectSpy = vi.fn();

    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallback = cb;
      }
      observe = vi.fn();
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
