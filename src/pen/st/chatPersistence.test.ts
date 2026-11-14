import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureChatSaveFetchObserver,
  runWithObservedChatSave,
  teardownChatSaveObserver,
} from '@pen/st/chatPersistence';
import type { STContext } from '@pen/st/context';
import { hasFetchPipelineSlot } from '../../features/fetchPipeline.js';

function installContext(context: Partial<STContext>): void {
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => ({
        chat: [],
        name1: 'User',
        name2: 'Char',
        getRequestHeaders: () => ({}),
        ...context,
      }),
    },
  });
}

async function gzipString(text: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  const stream = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

afterEach(() => {
  teardownChatSaveObserver();
  vi.unstubAllGlobals();
});

describe('P-4 / WP-1：chatPersistence 按需管道挂载、严格会话归属与压缩请求体解析', () => {
  it('无活跃观察作用域时不包裹 globalThis.fetch；作用域期间按需挂载、保留外层包装并在结束或 teardown 时彻底卸载', async () => {
    const baseFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', baseFetch);

    // 1. 空闲状态下调用 ensureChatSaveFetchObserver 绝不包裹 globalThis.fetch
    ensureChatSaveFetchObserver();
    expect(globalThis.fetch).toBe(baseFetch);
    expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);

    installContext({
      characterId: 0,
      characters: [{ name: 'Alice', avatar: 'alice.png', chat: 'chat-a' }],
      getCurrentChatId: () => 'chat-a',
    });

    // 2. 进入观察作用域时挂载管道，支持外层包装共存，结束后无其它槽位时自动还原 baseFetch
    await runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: true,
      },
      async () => {
        const dispatcher = globalThis.fetch;
        expect(dispatcher).not.toBe(baseFetch);
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(true);

        const outerWrapper = Object.assign(
          function outer(input: RequestInfo | URL, init?: RequestInit) {
            return (outerWrapper as unknown as { __baiBaiToolkitOriginalFetch: typeof fetch }).__baiBaiToolkitOriginalFetch(
              input,
              init,
            );
          },
          { __baiBaiToolkitOriginalFetch: dispatcher },
        );
        globalThis.fetch = outerWrapper as unknown as typeof fetch;

        ensureChatSaveFetchObserver();
        expect(globalThis.fetch).toBe(outerWrapper);

        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-a', chat: [] }),
        });

        // 卸载验证前去掉外层手工包装测试：外层仍保留且 __baiBaiToolkitOriginalFetch 会在作用域退出时缝合回 baseFetch
        expect(
          (outerWrapper as unknown as { __baiBaiToolkitOriginalFetch: typeof fetch }).__baiBaiToolkitOriginalFetch,
        ).toBe(dispatcher);
      },
    );

    expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);
    expect(
      (globalThis.fetch as unknown as { __baiBaiToolkitOriginalFetch: typeof fetch }).__baiBaiToolkitOriginalFetch,
    ).toBe(baseFetch);

    // 3. 测试中用全新 mock 完全替换 globalThis.fetch 时，新观察作用域能够重新锚定并在 teardownChatSaveObserver 时立即卸载
    const freshMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', freshMock);

    let releaseAction!: () => void;
    const actionGate = new Promise<void>(resolve => {
      releaseAction = resolve;
    });

    const running = runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: false,
      },
      async () => {
        expect(globalThis.fetch).not.toBe(freshMock);
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(true);
        teardownChatSaveObserver();
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);
        expect(globalThis.fetch).toBe(freshMock);
        releaseAction();
      },
    );

    await running;
    expect(globalThis.fetch).toBe(freshMock);
  });

  it('异步请求体乱序解析完成时，仍严格按请求派发顺序判定最终保存结果', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'integrity' }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    installContext({
      characterId: 0,
      characters: [{ name: 'Alice', avatar: 'alice.png', chat: 'chat-order' }],
      getCurrentChatId: () => 'chat-order',
    });

    // 构造第 1 次请求的 Blob.arrayBuffer() 比第 2 次请求更晚 resolve，验证派发槽位保序
    let releaseFirstBody!: () => void;
    const firstBodyGate = new Promise<void>(resolve => {
      releaseFirstBody = resolve;
    });
    const slowFirstBlob = {
      async arrayBuffer() {
        await firstBodyGate;
        return new TextEncoder().encode(
          JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-order' }),
        ).buffer;
      },
    } as unknown as Blob;
    Object.setPrototypeOf(slowFirstBlob, Blob.prototype);

    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'chat-order',
          expectedIdentity: 'character:alice.png\u0000chat-order',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', { method: 'POST', body: slowFirstBlob });
          await fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-order', force: true }),
          });
          releaseFirstBody();
        },
      ),
    ).resolves.toMatchObject({ observedHttpSave: true });
  });

  it('支持从 gzip 压缩字节流、Uint8Array 与 Request 实例提取目标会话并隔离异卡后台保存', async () => {
    const receivedBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input instanceof Request) {
          // 确认观察器通过 clone() 读取，未消费传给底层 fetch 的原始 Request 流
          receivedBodies.push(await input.text());
        } else if (init?.body instanceof Uint8Array) {
          receivedBodies.push(`gzip:${init.body.byteLength}`);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    installContext({
      characterId: 0,
      characters: [{ name: 'Alice', avatar: 'alice.png', chat: 'chat-gz' }],
      getCurrentChatId: () => 'chat-gz',
    });

    // 1. 仅收到其他会话 ('other-chat') 的 gzip 保存请求时，不应误判为当前会话已落盘
    const otherGzipped = await gzipString(
      JSON.stringify({ avatar_url: 'alice.png', file_name: 'other-chat', chat: [] }),
    );
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'chat-gz',
          expectedIdentity: 'character:alice.png\u0000chat-gz',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
            body: otherGzipped as unknown as BodyInit,
          });
        },
      ),
    ).rejects.toThrow('未触发落盘请求');

    // 2. 当前会话以 gzip 压缩体或 Request 实例发送时，准确匹配并通过落盘校验
    const targetGzipped = await gzipString(
      JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-gz.jsonl', chat: [] }),
    );
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'chat-gz',
          expectedIdentity: 'character:alice.png\u0000chat-gz',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
            body: targetGzipped as unknown as BodyInit,
          });
        },
      ),
    ).resolves.toMatchObject({ observedHttpSave: true });

    installContext({
      groupId: 'grp-1',
      getCurrentChatId: () => 'grp-chat-1',
    });

    const req = new Request('http://localhost/api/chats/group/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'grp-chat-1', chat: [] }),
    });
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'grp-chat-1',
          expectedIdentity: 'group:grp-1\u0000grp-chat-1',
          requireHttpSave: true,
        },
        async () => {
          await fetch(req);
        },
      ),
    ).resolves.toMatchObject({ observedHttpSave: true });
    expect(receivedBodies.at(-1)).toBe(JSON.stringify({ id: 'grp-chat-1', chat: [] }));
  });

  it('同名聊天文件 main 在不同角色卡之间严格隔离，缺少/损坏请求体绝不回退 liveIdentity，且 action 返回 false 时强制失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    installContext({
      characterId: 0,
      characters: [
        { name: 'Alice', avatar: 'alice.png', chat: 'main' },
        { name: 'Bob', avatar: 'bob.png', chat: 'main' },
      ],
      getCurrentChatId: () => 'main',
    });

    // 1. 角色 B (bob.png) 保存同名 file_name='main' 返回 200 OK 时，绝不能记到角色 A (alice.png) 账上
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'main',
          expectedIdentity: 'character:alice.png\u0000main',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'bob.png', ch_name: 'Bob', file_name: 'main', chat: [] }),
          });
        },
      ),
    ).rejects.toThrow('未触发落盘请求');

    // 2. 请求体缺失或非 JSON 时，绝不回退 liveIdentity 假阳性放行
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'main',
          expectedIdentity: 'character:alice.png\u0000main',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', { method: 'POST', body: '{broken-json' });
        },
      ),
    ).rejects.toThrow('未触发落盘请求');

    // 3. 即便等待锁期间前序同会话保存返回了 200 OK，只要本次 saveChatConditional 因切卡守卫返回 false，必须判定本次保存失败
    await expect(
      runWithObservedChatSave(
        {
          expectedChatId: 'main',
          expectedIdentity: 'character:alice.png\u0000main',
          requireHttpSave: true,
        },
        async () => {
          await fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'alice.png', ch_name: 'Alice', file_name: 'main', chat: [] }),
          });
          return false;
        },
      ),
    ).rejects.toThrow('聊天保存未完成');
  });
});
