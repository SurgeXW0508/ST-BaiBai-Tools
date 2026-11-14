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

describe('P-4 / WP-1：chatPersistence 按需管道挂载、无标记外部包装共存与严格会话归属', () => {
  it('无活跃观察作用域时不包裹 globalThis.fetch；与无标记外部 fetch 包装共存不递归，且空闲无外层包装时还原 baseFetch', async () => {
    let networkCalls = 0;
    const baseFetch = vi.fn(async () => {
      networkCalls += 1;
      return new Response('{"ok":true}', { status: 200 });
    });
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

    // 2. 无外部包装时：进入观察作用域挂载调度器，退出后完全还原 baseFetch
    await runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: true,
      },
      async () => {
        expect(globalThis.fetch).not.toBe(baseFetch);
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(true);
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-a', chat: [] }),
        });
      },
    );
    expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);
    expect(globalThis.fetch).toBe(baseFetch);
    expect(networkCalls).toBe(1);

    // 3. 其它扩展在我们挂载后以无任何自定义属性标签的闭包包装 globalThis.fetch：
    //    后续再次注册/切换/退出再进入观察作用域时，绝不能二次包裹形成无限递归！
    let foreignWrapperCalls = 0;
    await runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: true,
      },
      async () => {
        const currentFetch = globalThis.fetch;
        const untaggedForeignWrapper = function foreignFetch(
          input: RequestInfo | URL,
          init?: RequestInit,
        ) {
          foreignWrapperCalls += 1;
          return currentFetch(input, init);
        };
        globalThis.fetch = untaggedForeignWrapper as typeof fetch;

        // 触发二次同步挂载检查与嵌套观察作用域：必须保持 untaggedForeignWrapper 在最顶层且零递归
        ensureChatSaveFetchObserver();
        expect(globalThis.fetch).toBe(untaggedForeignWrapper);
        expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(true);

        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-a', chat: [] }),
        });
      },
    );
    expect(hasFetchPipelineSlot('chatSaveObserver')).toBe(false);
    expect(foreignWrapperCalls).toBe(1);
    expect(networkCalls).toBe(2);

    // 1 -> 0 -> 1 再次进入观察作用域（无标记外部包装仍在顶层）：依旧只执行一次且准确观测落盘
    await runWithObservedChatSave(
      {
        expectedChatId: 'chat-a',
        expectedIdentity: 'character:alice.png\u0000chat-a',
        requireHttpSave: true,
      },
      async () => {
        await fetch('/api/chats/save', {
          method: 'POST',
          body: JSON.stringify({ avatar_url: 'alice.png', file_name: 'chat-a', chat: [] }),
        });
      },
    );
    expect(foreignWrapperCalls).toBe(2);
    expect(networkCalls).toBe(3);

    // 4. 测试中用全新 mock 完全替换 globalThis.fetch 时，旧调度器退役，新观察作用域重新锚定并在 teardown 时立即还原
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
