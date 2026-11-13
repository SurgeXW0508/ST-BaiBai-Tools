import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteFloorsFrom, toggleFloorHidden } from '@pen/st/floorActions';

function installContext(context: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => context,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toggleFloorHidden', () => {
  it('hides a visible floor via /hide', async () => {
    const run = vi.fn(async () => undefined);
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: run,
    });

    await expect(toggleFloorHidden(0)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('/hide 0', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('unhides a hidden floor via /unhide', async () => {
    const run = vi.fn(async () => undefined);
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: true, mes: '正文' }],
      executeSlashCommandsWithOptions: run,
    });

    await expect(toggleFloorHidden(0)).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith('/unhide 0', expect.anything());
  });

  it('throws when the slash command reports an error', async () => {
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: vi.fn(async () => ({
        isError: true,
        errorMessage: '命令失败',
      })),
    });

    await expect(toggleFloorHidden(0)).rejects.toThrow('命令失败');
  });

  it('throws when the floor does not exist', async () => {
    installContext({ chat: [] });
    await expect(toggleFloorHidden(3)).rejects.toThrow('楼层不存在');
  });
});

describe('deleteFloorsFrom', () => {
  it('deletes the floor and everything after it via /del', async () => {
    const run = vi.fn(async () => undefined);
    const chat = Array.from({ length: 5 }, () => ({
      name: '角色',
      is_user: false,
      is_system: false,
      mes: '正文',
    }));
    installContext({
      chat,
      executeSlashCommandsWithOptions: run,
      callGenericPopup: vi.fn(async () => true),
      POPUP_TYPE: { CONFIRM: 'confirm' },
    });

    await expect(deleteFloorsFrom(2)).resolves.toBe(3);
    expect(run).toHaveBeenCalledWith('/del 3', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('does nothing when the user cancels the confirm popup', async () => {
    const run = vi.fn(async () => undefined);
    installContext({
      chat: [{ name: '角色', is_user: false, is_system: false, mes: '正文' }],
      executeSlashCommandsWithOptions: run,
      callGenericPopup: vi.fn(async () => false),
      POPUP_TYPE: { CONFIRM: 'confirm' },
    });

    await expect(deleteFloorsFrom(0)).resolves.toBe(0);
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

    await expect(deleteFloorsFrom(1)).rejects.toThrow('确认期间当前聊天已切换');
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
  });

  it('re-confirms with updated count when new floors arrive in the same chat during popup', async () => {
    const run = vi.fn(async () => undefined);
    const prompts: string[] = [];
    const chat = [
      { name: '角色', is_user: false, is_system: false, mes: 'F0' },
      { name: '角色', is_user: false, is_system: false, mes: 'F1' },
      { name: '角色', is_user: false, is_system: false, mes: 'F2' },
    ];

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

    await expect(deleteFloorsFrom(1)).resolves.toBe(3);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('第 1 至 #2 层（共 2 条）');
    expect(prompts[1]).toContain('第 1 至 #3 层（共 3 条）');
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('/del 3', {
      handleExecutionErrors: true,
      source: 'baibai-pen',
    });
  });

  it('surfaces HTTP 500 persistence failure if /del triggers a failing chat save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Server Error', { status: 500 })),
    );
    const chat = [{ name: '角色', is_user: false, is_system: false, mes: '正文' }];
    installContext({
      chat,
      getCurrentChatId: () => 'chat-a',
      POPUP_TYPE: { CONFIRM: 'confirm' },
      callGenericPopup: vi.fn(async () => true),
      executeSlashCommandsWithOptions: vi.fn(async () => {
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ file_name: 'chat-a', chat: [] }),
        });
        return undefined;
      }),
    });

    await expect(deleteFloorsFrom(0)).rejects.toThrow('HTTP 500');
  });
});
