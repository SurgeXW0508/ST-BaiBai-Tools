import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyFloorText, getFloorSourceText, openFloorInPen } from '@pen/st/openFloor';
import { ui } from '@pen/state/ui';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => context,
    },
  });
  vi.stubGlobal('document', {
    querySelector: vi.fn(() => null),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('floor access without rendered messages', () => {
  it('opens a floor directly from the chat array', () => {
    installContext({
      chat: [
        {
          name: '角色',
          is_user: false,
          is_system: true,
          mes: '未渲染的楼层正文',
        },
      ],
      getCurrentChatId: () => 'chat-a',
    });

    expect(openFloorInPen(0)).toBe(true);
    expect(ui.floor).toBe(0);
    expect(ui.originalText).toBe('未渲染的楼层正文');
    expect(ui.chatId).toBe('chat-a');
  });

  it('reads the active editor value before the persisted message text', () => {
    const editor = { value: '编辑器中的正文' };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [{ name: '角色', is_user: false, is_system: false, mes: '已保存正文' }],
        }),
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({
        querySelector: vi.fn(() => editor),
      })),
    });

    expect(getFloorSourceText(0)).toBe('编辑器中的正文');
  });

  it('opens a floor with active #curEditTextarea text so trimmed native edits never false-trip floor-changed', async () => {
    const editor = { value: '酒馆编辑框中已去空白的正文' };
    let editorOpen = true;
    const cancel = {
      click: vi.fn(() => {
        editorOpen = false;
      }),
    };
    const messageElement = {
      querySelector: vi.fn((selector: string) => {
        if (selector === '#curEditTextarea') return editorOpen ? editor : null;
        if (selector === '.mes_edit_cancel') return cancel;
        return null;
      }),
    };
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '  酒馆编辑框中已去空白的正文  ',
      swipes: ['  酒馆编辑框中已去空白的正文  '],
      swipe_id: 0,
    };
    const chat = [message];
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat,
          getCurrentChatId: () => 'chat-a',
          saveChat: vi.fn(async () => undefined),
        }),
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => messageElement),
    });

    expect(openFloorInPen(0)).toBe(true);
    expect(ui.originalText).toBe('酒馆编辑框中已去空白的正文');
    await expect(
      applyFloorText(0, ui.originalText, '修订后正文', ui.chatId, ui.chatIdentity),
    ).resolves.toBe('saved');
    expect(message.mes).toBe('修订后正文');
  });

  it('persists before refreshing the message and emitting update events', async () => {
    const actions: string[] = [];
    const emit = vi.fn(async (event: string) => {
      actions.push(event);
    });
    const saveChat = vi.fn(async () => {
      actions.push('save');
    });
    const updateMessageBlock = vi.fn(() => {
      actions.push('refresh');
    });
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['旧分支', '原文'],
      swipe_id: 1,
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat,
      updateMessageBlock,
      eventSource: { emit },
      eventTypes: {
        MESSAGE_EDITED: 'edited',
        MESSAGE_UPDATED: 'updated',
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({
        querySelector: vi.fn(() => null),
      })),
    });

    await expect(applyFloorText(0, '原文', '新正文', 'chat-a')).resolves.toBe('saved');
    expect(message.mes).toBe('新正文');
    expect(message.swipes).toEqual(['旧分支', '新正文']);
    expect(emit).toHaveBeenNthCalledWith(1, 'edited', 0);
    expect(emit).toHaveBeenNthCalledWith(2, 'updated', 0);
    expect(saveChat).toHaveBeenCalledOnce();
    expect(updateMessageBlock).toHaveBeenCalledWith(0, message);
    expect(actions).toEqual(['save', 'edited', 'refresh', 'updated']);
  });

  it('settles an active ST editor without flattening HTML or line breaks, and falls back to refresh if cancel leaves textarea open', async () => {
    const actions: string[] = [];
    const nextText = '<section>\n\n  <p>保留格式</p>\n</section>';
    const editor = { value: '原文' };
    let editorOpen = true;
    const cancel = {
      click: vi.fn(() => {
        actions.push('cancel');
        editorOpen = false;
      }),
    };
    const messageElement = {
      querySelector: vi.fn((selector: string) => {
        if (selector === '#curEditTextarea') return editorOpen ? editor : null;
        if (selector === '.mes_edit_cancel') return cancel;
        return null;
      }),
    };
    const updateMessageBlock = vi.fn(() => {
      actions.push('refresh');
    });
    const emit = vi.fn(async (event: string) => {
      actions.push(event);
    });
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        actions.push('save');
      }),
      updateMessageBlock,
      eventSource: { emit },
      eventTypes: {
        MESSAGE_EDITED: 'edited',
        MESSAGE_UPDATED: 'updated',
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => messageElement),
    });

    await expect(applyFloorText(0, '原文', nextText, 'chat-a')).resolves.toBe('saved');
    expect(message.mes).toBe(nextText);
    expect(message.swipes).toEqual([nextText]);
    expect(editor.value).toBe(nextText);
    expect(cancel.click).toHaveBeenCalledOnce();
    expect(updateMessageBlock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('edited', 0);
    expect(actions).toEqual(['save', 'edited', 'cancel']);

    // 当 .mes_edit_cancel 未能关闭原生编辑框（如 this_edit_mes_id 失步）时，必须退回 refreshRenderedMessage
    actions.length = 0;
    editorOpen = true;
    editor.value = nextText;
    cancel.click.mockImplementationOnce(() => {
      actions.push('cancel-noop');
    });
    await expect(applyFloorText(0, nextText, '回退刷新正文', 'chat-a')).resolves.toBe('saved');
    expect(updateMessageBlock).toHaveBeenCalledOnce();
    expect(actions).toEqual(['save', 'edited', 'cancel-noop', 'refresh', 'updated']);
  });

  it('keeps a synchronized editor intact when an older ST has no cancel button', async () => {
    const nextText = '<div>\n第一行\n\n第二行\n</div>';
    const editor = { value: '原文' };
    const messageElement = {
      querySelector: vi.fn((selector: string) =>
        selector === '#curEditTextarea' ? editor : null,
      ),
    };
    const updateMessageBlock = vi.fn();
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
      updateMessageBlock,
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => messageElement),
    });

    await expect(applyFloorText(0, '原文', nextText, 'chat-a')).resolves.toBe('saved');
    expect(editor.value).toBe(nextText);
    expect(updateMessageBlock).not.toHaveBeenCalled();
  });

  it('updates swipes[0] when an old message has no swipe_id', async () => {
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => undefined),
    });

    await expect(applyFloorText(0, '原文', '新正文', 'chat-a')).resolves.toBe('saved');
    expect(message.mes).toBe('新正文');
    expect(message.swipes).toEqual(['新正文']);
  });

  it('saves before falling back to a full chat reload on older ST versions', async () => {
    const actions: string[] = [];
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        actions.push('save');
      }),
      reloadCurrentChat: vi.fn(async () => {
        actions.push('reload');
      }),
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({
        querySelector: vi.fn(() => null),
      })),
    });

    await expect(applyFloorText(0, '原文', '新正文', 'chat-a')).resolves.toBe('saved');
    expect(actions).toEqual(['save', 'reload']);
  });

  it('rolls back the message and current swipe when saving fails', async () => {
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
    };
    installContext({
      chat: [message],
      getCurrentChatId: () => 'chat-a',
      saveChat: vi.fn(async () => {
        throw new Error('保存失败');
      }),
    });

    await expect(applyFloorText(0, '原文', '新正文', 'chat-a')).rejects.toThrow('保存失败');
    expect(message.mes).toBe('原文');
    expect(message.swipes).toEqual(['原文']);
  });

  it('rolls back and suppresses DOM/events when ST saveChatConditional swallows HTTP 500', async () => {
    const emit = vi.fn(async () => undefined);
    const updateMessageBlock = vi.fn();
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '磁盘原文',
      swipes: ['旧分支', '磁盘原文'],
      swipe_id: 1,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })),
    );

    async function saveChatConditional(): Promise<void> {
      const response = await fetch('/api/chats/save', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: 'char.png', file_name: 'chat-a', chat: [message] }),
      });
      if (!response.ok) {
        // 模拟酒馆原生 saveChat 吞掉 HTTP 500 只弹 toastr 不抛异常
        return;
      }
    }

    installContext({
      chat: [message],
      characterId: 0,
      characters: [{ name: '角色', avatar: 'char.png', chat: 'chat-a' }],
      getCurrentChatId: () => 'chat-a',
      saveChat: saveChatConditional,
      updateMessageBlock,
      eventSource: { emit },
      eventTypes: {
        MESSAGE_EDITED: 'edited',
        MESSAGE_UPDATED: 'updated',
      },
    });

    await expect(
      applyFloorText(0, '磁盘原文', '改写草稿', 'chat-a', 'character:char.png\u0000chat-a'),
    ).rejects.toThrow('HTTP 500');
    expect(message.mes).toBe('磁盘原文');
    expect(message.swipes).toEqual(['旧分支', '磁盘原文']);
    expect(updateMessageBlock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rolls back when saveChatConditional returns early on save-lock timeout without issuing fetch', async () => {
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    async function saveChatConditional(): Promise<void> {
      // 模拟 waitUntilCondition(() => !isChatSaving) 超时直接 return
      return;
    }

    installContext({
      chat: [message],
      characterId: 0,
      characters: [{ name: '角色', avatar: 'char.png', chat: 'chat-a' }],
      getCurrentChatId: () => 'chat-a',
      saveChat: saveChatConditional,
    });

    await expect(applyFloorText(0, '原文', '新正文', 'chat-a')).rejects.toThrow('未触发落盘请求');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(message.mes).toBe('原文');
    expect(message.swipes).toEqual(['原文']);
  });

  it('treats integrity error followed by successful force overwrite retry as saved', async () => {
    const message = {
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '原文',
      swipes: ['原文'],
      swipe_id: 0,
    };
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: 'integrity' }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    async function saveChatConditional(): Promise<void> {
      const first = await fetch('/api/chats/save', {
        method: 'POST',
        body: JSON.stringify({ avatar_url: 'char.png', file_name: 'chat-a', force: false }),
      });
      if (!first.ok) {
        const err = await first.json();
        if (err.error === 'integrity') {
          await fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'char.png', file_name: 'chat-a', force: true }),
          });
        }
      }
    }

    installContext({
      chat: [message],
      characterId: 0,
      characters: [{ name: '角色', avatar: 'char.png', chat: 'chat-a' }],
      getCurrentChatId: () => 'chat-a',
      saveChat: saveChatConditional,
    });

    await expect(applyFloorText(0, '原文', '覆盖后正文', 'chat-a')).resolves.toBe('saved');
    expect(calls).toBe(2);
    expect(message.mes).toBe('覆盖后正文');
  });

  it('rejects and rolls back Character A when user switches to Character B with same file_name during save lock wait', async () => {
    const messageA = {
      name: 'Alice',
      is_user: false,
      is_system: false,
      mes: 'Alice 原文',
      swipes: ['Alice 原文'],
      swipe_id: 0,
    };
    const messageB = {
      name: 'Bob',
      is_user: false,
      is_system: false,
      mes: 'Bob 原文',
      swipes: ['Bob 原文'],
      swipe_id: 0,
    };
    const chatA = [messageA];
    const chatB = [messageB];
    const characters = [
      { name: 'Alice', avatar: 'alice.png', chat: 'main' },
      { name: 'Bob', avatar: 'bob.png', chat: 'main' },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    let activeContext: Record<string, unknown> = {
      chat: chatA,
      characterId: 0,
      characters,
      getCurrentChatId: () => 'main',
      saveChat: async () => {
        // 模拟等待保存锁期间用户切到角色 B，并且角色 B 触发了一次同名 file_name='main' 的 200 OK 保存
        activeContext = {
          ...activeContext,
          chat: chatB,
          characterId: 1,
          getCurrentChatId: () => 'main',
        };
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({
            avatar_url: 'bob.png',
            ch_name: 'Bob',
            file_name: 'main',
            chat: chatB,
          }),
        });
        return false;
      },
    };

    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => activeContext,
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
    });

    await expect(
      applyFloorText(0, 'Alice 原文', 'Alice 改写草稿', 'main', 'character:alice.png\u0000main'),
    ).rejects.toThrow();

    expect(messageA.mes).toBe('Alice 原文');
    expect(messageA.swipes).toEqual(['Alice 原文']);
    expect(messageB.mes).toBe('Bob 原文');
    expect(messageB.swipes).toEqual(['Bob 原文']);
  });

  it('skips DOM settlement, refresh, reloadCurrentChat, and MESSAGE_UPDATED on Character B if MESSAGE_EDITED switches chats after Character A persisted', async () => {
    const messageA = {
      name: 'Alice',
      is_user: false,
      is_system: false,
      mes: 'Alice 原文',
      swipes: ['Alice 原文'],
      swipe_id: 0,
    };
    const messageB = {
      name: 'Bob',
      is_user: false,
      is_system: false,
      mes: 'Bob 原文',
      swipes: ['Bob 原文'],
      swipe_id: 0,
    };
    const chatA = [messageA];
    const chatB = [messageB];
    const characters = [
      { name: 'Alice', avatar: 'alice.png', chat: 'chat-a' },
      { name: 'Bob', avatar: 'bob.png', chat: 'chat-b' },
    ];
    const bobEditor = { value: 'Bob 正在编辑的内容' };
    const bobCancel = { click: vi.fn() };
    const updateB = vi.fn();
    const reloadB = vi.fn(async () => undefined);
    const emitEvents: Array<[string, number]> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    let activeContext: Record<string, unknown> = {
      chat: chatA,
      characterId: 0,
      characters,
      getCurrentChatId: () => 'chat-a',
      saveChat: async () => {
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({
            avatar_url: 'alice.png',
            ch_name: 'Alice',
            file_name: 'chat-a',
            chat: chatA,
          }),
        });
      },
      eventTypes: {
        MESSAGE_EDITED: 'edited',
        MESSAGE_UPDATED: 'updated',
      },
      eventSource: {
        emit: vi.fn(async (evt: string, idx: number) => {
          emitEvents.push([evt, idx]);
          if (evt === 'edited') {
            // 异步 MESSAGE_EDITED 回调期间切到会话 B
            activeContext = {
              ...activeContext,
              chat: chatB,
              characterId: 1,
              getCurrentChatId: () => 'chat-b',
              updateMessageBlock: updateB,
              reloadCurrentChat: reloadB,
            };
          }
        }),
      },
    };

    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => activeContext,
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => {
        if (activeContext.characterId !== 1) return null;
        return {
          querySelector: (sel: string) => {
            if (sel === '#curEditTextarea') return bobEditor;
            if (sel === '.mes_edit_cancel') return bobCancel;
            return null;
          },
        };
      }),
    });

    await expect(
      applyFloorText(0, 'Alice 原文', 'Alice 已落盘新文', 'chat-a', 'character:alice.png\u0000chat-a'),
    ).resolves.toBe('saved');

    expect(messageA.mes).toBe('Alice 已落盘新文');
    expect(bobEditor.value).toBe('Bob 正在编辑的内容');
    expect(bobCancel.click).not.toHaveBeenCalled();
    expect(updateB).not.toHaveBeenCalled();
    expect(reloadB).not.toHaveBeenCalled();
    expect(emitEvents).toEqual([['edited', 0]]);
  });

  it('rejects temporary chats and active streaming before mutating message memory', async () => {
    const tempMessage = { name: 'Assistant', is_user: false, is_system: false, mes: '临时正文' };
    const saveChat = vi.fn(async () => undefined);
    installContext({
      chat: [tempMessage],
      getCurrentChatId: () => undefined,
      saveChat,
    });

    await expect(applyFloorText(0, '临时正文', '修改')).rejects.toThrow('尚未创建存档文件');
    expect(tempMessage.mes).toBe('临时正文');
    expect(saveChat).not.toHaveBeenCalled();

    installContext({
      chat: [tempMessage],
      getCurrentChatId: () => 'chat-a',
      streamingProcessor: { isFinished: false },
      saveChat,
    });

    await expect(applyFloorText(0, '临时正文', '修改', 'chat-a')).rejects.toThrow('正在生成回复');
    expect(tempMessage.mes).toBe('临时正文');
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('detects cross-character chat collision and mid-save chat switch', async () => {
    const messageA = { name: 'Alice', is_user: false, is_system: false, mes: '原文' };
    const messageB = { name: 'Bob', is_user: false, is_system: false, mes: '另一角色同文件名' };
    let activeContext: Record<string, unknown> = {
      chat: [messageB],
      characterId: 1,
      characters: [
        { name: 'Alice', avatar: 'alice.png', chat: 'same-name' },
        { name: 'Bob', avatar: 'bob.png', chat: 'same-name' },
      ],
      getCurrentChatId: () => 'same-name',
      saveChat: vi.fn(async () => undefined),
    };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => activeContext,
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
    });

    await expect(
      applyFloorText(0, '原文', '新正文', 'same-name', 'character:alice.png\u0000same-name'),
    ).resolves.toBe('chat-changed');

    const updateMessageBlock = vi.fn();
    activeContext = {
      chat: [messageA],
      characterId: 0,
      characters: [
        { name: 'Alice', avatar: 'alice.png', chat: 'chat-a' },
        { name: 'Bob', avatar: 'bob.png', chat: 'chat-b' },
      ],
      getCurrentChatId: () => 'chat-a',
      updateMessageBlock,
      saveChat: vi.fn(async () => {
        activeContext = {
          ...activeContext,
          chat: [messageB],
          characterId: 1,
          getCurrentChatId: () => 'chat-b',
        };
      }),
    };

    await expect(
      applyFloorText(0, '原文', '新正文', 'chat-a', 'character:alice.png\u0000chat-a'),
    ).resolves.toBe('chat-changed');
    expect(messageA.mes).toBe('原文');
    expect(updateMessageBlock).not.toHaveBeenCalled();
  });
});
