import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureChatSaveFetchObserver,
  runWithObservedChatSave,
} from '@pen/st/chatPersistence';
import type { STContext } from '@pen/st/context';

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
  vi.unstubAllGlobals();
});

describe('P-4：chatPersistence 幂等链式安装、派发保序与压缩/二进制请求体解析', () => {
  it('外层再挂载其他 fetch 包装器时绝不重复包裹第二层，而测试替换全新 fetch 时仍能正常重装', () => {
    const baseFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', baseFetch);

    ensureChatSaveFetchObserver();
    const firstObserved = globalThis.fetch;
    expect(firstObserved).not.toBe(baseFetch);

    // 模拟其它模块在 observed 之上再包一层并挂接 __baiBaiToolkitOriginalFetch
    const outerWrapper = Object.assign(
      function outer(input: RequestInfo | URL, init?: RequestInit) {
        return firstObserved(input, init);
      },
      { __baiBaiToolkitOriginalFetch: firstObserved },
    );
    globalThis.fetch = outerWrapper as typeof fetch;

    ensureChatSaveFetchObserver();
    expect(globalThis.fetch).toBe(outerWrapper);

    // 测试中用全新 mock 完全替换 globalThis.fetch 时，能够重新挂载
    const freshMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', freshMock);
    ensureChatSaveFetchObserver();
    expect(globalThis.fetch).not.toBe(freshMock);
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
        return new TextEncoder().encode(JSON.stringify({ file_name: 'chat-order' })).buffer;
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
            body: JSON.stringify({ file_name: 'chat-order', force: true }),
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
    const otherGzipped = await gzipString(JSON.stringify({ file_name: 'other-chat', chat: [] }));
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
      JSON.stringify({ file_name: 'chat-gz.jsonl', chat: [] }),
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
});
