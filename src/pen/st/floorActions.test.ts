import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteFloorsFrom,
  resolveEffectiveDeleteStartFloor,
  toggleFloorHidden,
} from '@pen/st/floorActions';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => context,
    },
  });
  vi.stubGlobal('document', {
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toggleFloorHidden', () => {
  it('hides a visible floor via /hide and verifies post-condition', async () => {
    const chat = [{ name: '角色', is_user: false, is_system: false, mes: '正文' }];
    const run = vi.fn(async () => {
      chat[0]!.is_system = true;
      return undefined;
    });
    installContext({
      chat,
      executeSlashCommandsWithOptions: run,
    });

    await expect(toggleFloorHidden(0)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('/hide 0', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('unhides a hidden floor via /unhide', async () => {
    const chat = [{ name: '角色', is_user: false, is_system: true, mes: '正文' }];
    const run = vi.fn(async () => {
      chat[0]!.is_system = false;
      return undefined;
    });
    installContext({
      chat,
      executeSlashCommandsWithOptions: run,
    });

    await expect(toggleFloorHidden(0)).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith('/unhide 0', expect.anything());
  });

  it('blocks /hide when #curEditTextarea has unsaved edits, and cancels clean #curEditTextarea automatically', async () => {
    const chat = [{ name: '角色', is_user: false, is_system: false, mes: '  原始正文  ' }];
    const run = vi.fn(async () => {
      chat[0]!.is_system = true;
      return undefined;
    });
    let editorValue = '用户改了一半尚未保存';
    let editorOpen = true;
    const cancelBtn = {
      click: vi.fn(() => {
        editorOpen = false;
      }),
    };
    const mesNode = {
      getAttribute: (name: string) => (name === 'mesid' ? '0' : null),
      querySelector: (sel: string) => {
        if (sel === '#curEditTextarea') return editorOpen ? { value: editorValue } : null;
        if (sel === '.mes_edit_cancel') return cancelBtn;
        return null;
      },
    };
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat,
          executeSlashCommandsWithOptions: run,
        }),
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => mesNode),
      querySelectorAll: vi.fn(() => (editorOpen ? [mesNode] : [])),
    });

    await expect(toggleFloorHidden(0)).rejects.toThrow('正在酒馆原生编辑框中修改且未保存');
    expect(run).not.toHaveBeenCalled();

    // 当原生编辑框文本仅与 mes.trim() 一致（未改动）时，应自动取消编辑框后继续隐藏
    editorValue = '原始正文';
    await expect(toggleFloorHidden(0)).resolves.toBe(true);
    expect(cancelBtn.click).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('throws when the slash command reports an error or leaves post-condition unmet', async () => {
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: vi.fn(async () => ({
        isError: true,
        errorMessage: '命令失败',
      })),
    });

    await expect(toggleFloorHidden(0)).rejects.toThrow('命令失败');

    // 无报错但未实际切换 is_system 时抛后置校验异常
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: vi.fn(async () => undefined),
    });
    await expect(toggleFloorHidden(0)).rejects.toThrow('状态未生效');
  });

  it('throws when the floor does not exist', async () => {
    installContext({ chat: [] });
    await expect(toggleFloorHidden(3)).rejects.toThrow('楼层不存在');
  });
});

describe('deleteFloorsFrom', () => {
  it('deletes the floor and everything after it via /del toolcalls=false', async () => {
    const chat = Array.from({ length: 5 }, () => ({
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '正文',
    }));
    const run = vi.fn(async () => {
      chat.splice(2);
      return undefined;
    });
    installContext({
      chat,
      executeSlashCommandsWithOptions: run,
      callGenericPopup: vi.fn(async () => true),
      POPUP_TYPE: { CONFIRM: 'confirm' },
    });

    await expect(deleteFloorsFrom(2)).resolves.toEqual({
      deletedCount: 3,
      effectiveStartFloor: 2,
    });
    expect(run).toHaveBeenCalledWith('/del toolcalls=false 3', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('includes preceding tool_invocations system carrier floors in effectiveStartFloor and prompt', async () => {
    const prompts: string[] = [];
    const chat = [
      { name: 'User', is_user: true, is_system: false, mes: '帮我查天气' },
      {
        name: 'System',
        is_user: false,
        is_system: true,
        mes: '',
        extra: { tool_invocations: [{ id: 'call_1' }] },
      },
      {
        name: 'System',
        is_user: false,
        is_system: true,
        mes: '',
        extra: { tool_invocations: [{ id: 'call_2' }] },
      },
      { name: 'Char', is_user: false, is_system: false, mes: '今天晴天' },
    ];
    expect(resolveEffectiveDeleteStartFloor(chat, 3)).toBe(1);

    const run = vi.fn(async () => {
      chat.splice(1);
      return undefined;
    });
    installContext({
      chat,
      executeSlashCommandsWithOptions: run,
      POPUP_TYPE: { CONFIRM: 'confirm' },
      callGenericPopup: vi.fn(async (msg: string) => {
        prompts.push(msg);
        return true;
      }),
    });

    await expect(deleteFloorsFrom(3)).resolves.toEqual({
      deletedCount: 3,
      effectiveStartFloor: 1,
    });
    expect(prompts[0]).toContain('关联工具调用记录');
    expect(prompts[0]).toContain('第 1 至 #3 层（共 3 条）');
    expect(run).toHaveBeenCalledWith('/del toolcalls=false 3', expect.anything());
  });

  it('does nothing when the user cancels the confirm popup', async () => {
    const run = vi.fn(async () => undefined);
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: run,
      callGenericPopup: vi.fn(async () => false),
      POPUP_TYPE: { CONFIRM: 'confirm' },
    });

    await expect(deleteFloorsFrom(0)).resolves.toEqual({
      deletedCount: 0,
      effectiveStartFloor: 0,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('aborts without running /del if the active chat switches during confirmation', async () => {
    const runA = vi.fn(async () => undefined);
    const runB = vi.fn(async () => undefined);
    const chatA = Array.from({ length: 4 }, (_, i) => ({
      name: 'Alice',
      is_user: false,
      is_system: false,
      mes: `A-${i}`,
    }));
    const chatB = Array.from({ length: 6 }, (_, i) => ({
      name: 'Bob',
      is_user: false,
      is_system: false,
      mes: `B-${i}`,
    }));

    let activeContext: Record<string, unknown> = {
      chat: chatA,
      characterId: 0,
      characters: [
        { name: 'Alice', avatar: 'alice.png', chat: 'chat-a' },
        { name: 'Bob', avatar: 'bob.png', chat: 'chat-b' },
      ],
      getCurrentChatId: () => 'chat-a',
      executeSlashCommandsWithOptions: runA,
      POPUP_TYPE: { CONFIRM: 'confirm' },
      callGenericPopup: vi.fn(async () => {
        activeContext = {
          ...activeContext,
          chat: chatB,
          characterId: 1,
          getCurrentChatId: () => 'chat-b',
          executeSlashCommandsWithOptions: runB,
        };
        return true;
      }),
    };

    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => activeContext,
      },
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    });

    await expect(deleteFloorsFrom(1)).rejects.toThrow('确认期间当前聊天已切换');
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
  });

  it('re-confirms with updated count when new floors arrive in the same chat during popup', async () => {
    const prompts: string[] = [];
    const chat = [
      { name: '角色', is_user: false, is_system: false, mes: 'F0' },
      { name: '角色', is_user: false, is_system: false, mes: 'F1' },
      { name: '角色', is_user: false, is_system: false, mes: 'F2' },
    ];
    const run = vi.fn(async () => {
      chat.splice(1);
      return undefined;
    });

    installContext({
      chat,
      getCurrentChatId: () => 'chat-a',
      executeSlashCommandsWithOptions: run,
      POPUP_TYPE: { CONFIRM: 'confirm' },
      callGenericPopup: vi.fn(async (msg: string) => {
        prompts.push(msg);
        if (prompts.length === 1) {
          chat.push({ name: '角色', is_user: false, is_system: false, mes: 'F3-新增' });
          return true;
        }
        return true;
      }),
    });

    await expect(deleteFloorsFrom(1)).resolves.toEqual({
      deletedCount: 3,
      effectiveStartFloor: 1,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('第 1 至 #2 层（共 2 条）');
    expect(prompts[1]).toContain('第 1 至 #3 层（共 3 条）');
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('/del toolcalls=false 3', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('surfaces HTTP 500 persistence failure and invokes reloadCurrentChat to resync RAM/DOM with disk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Server Error', { status: 500 })),
    );
    const reloadCurrentChat = vi.fn(async () => undefined);
    const chat = [{ name: '角色', is_user: false, is_system: false, mes: '正文' }];
    installContext({
      chat,
      getCurrentChatId: () => 'chat-a',
      reloadCurrentChat,
      POPUP_TYPE: { CONFIRM: 'confirm' },
      callGenericPopup: vi.fn(async () => true),
      executeSlashCommandsWithOptions: vi.fn(async () => {
        chat.splice(0);
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ file_name: 'chat-a', chat: [] }),
        });
        return undefined;
      }),
    });

    await expect(deleteFloorsFrom(0)).rejects.toThrow('HTTP 500');
    expect(reloadCurrentChat).toHaveBeenCalledOnce();
  });
});
