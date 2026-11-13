import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeSideChannelBaseUrl,
  requireValidSideChannelBaseUrl,
} from '@pen/api/channelParams';
import type { ApiChannel } from '@pen/api/sharedChannels';
import {
  ApiError,
  buildRequestBody,
  fetchModels,
  requestCompletion,
  sanitizeExcludeParams,
  testChannel,
} from './client';

const channel: ApiChannel = {
  id: 'ch1',
  name: '测试渠道',
  url: 'https://api.example.com',
  key: 'k',
  model: 'm',
  temperature: 1,
  maxTokens: 1024,
  timeoutSec: 60,
  stream: false,
  prefill: true,
  excludeParams: [],
  reasoningEffort: '',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildRequestBody：思考强度与两条源分支', () => {
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const build = (over: Partial<ApiChannel> = {}) =>
    buildRequestBody({ ...channel, ...over }, msgs, 'https://api.example.com/v1');

  it('未设思考强度 → 走 openai 源，请求体与加功能前逐字节一致', () => {
    expect(build()).toEqual({
      chat_completion_source: 'openai',
      reverse_proxy: 'https://api.example.com/v1',
      proxy_password: 'k',
      model: 'm',
      messages: msgs,
      temperature: 1,
      max_tokens: 1024,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
    });
  });

  it('设了思考强度 → 切 custom 源，并经 custom_include_body 透传', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://api.example.com/v1');
    // 顶层不发 reasoning_effort：openai/custom 源都卡模型名白名单，
    // 模型名恰好命中时会覆盖掉我们真正想发的值
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.custom_include_body as string)).toEqual({ reasoning_effort: 'high' });
  });

  it('custom 源必须靠 header 带 key：proxy_password 在该源下不被读取', () => {
    const body = build({ reasoningEffort: 'high' });
    expect(body.proxy_password).toBeUndefined();
    expect(JSON.parse(body.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
  });

  it('key 含 YAML 元字符时仍能安全注入（靠 JSON.stringify 转义）', () => {
    // 手拼 YAML 会在这类 key 上解析失败；而 ST 的 mergeObjectWithYaml 是静默忽略，
    // header 注入失败 → 退回读 ST 自己的 Custom 密钥 → 可能把别家的 key 发到本端点。
    const nasty = 'sk-a:b#c{d}e*f "g"';
    const body = build({ reasoningEffort: 'high', key: nasty });
    expect(JSON.parse(body.custom_include_headers as string).Authorization).toBe(`Bearer ${nasty}`);
  });

  it('空白字符串视同未设（不误切 custom 源）', () => {
    expect(build({ reasoningEffort: '   ' }).chat_completion_source).toBe('openai');
  });

  it('取值不做白名单：非常规值原样透传', () => {
    const body = build({ reasoningEffort: '我自己的档位' });
    expect(JSON.parse(body.custom_include_body as string).reasoning_effort).toBe('我自己的档位');
  });

  it('excludeParams 在两条分支下都照常生效', () => {
    expect(build({ excludeParams: ['temperature'] }).temperature).toBeUndefined();
    expect(
      build({ excludeParams: ['temperature'], reasoningEffort: 'high' }).temperature,
    ).toBeUndefined();
  });

  it('excludeParams 绝不能删除认证、路由或核心消息控制字段', () => {
    const hostileExcludes = [
      'custom_include_headers',
      'custom_url',
      'custom_include_body',
      'reverse_proxy',
      'proxy_password',
      'chat_completion_source',
      'model',
      'messages',
      'stream',
      'temperature',
    ];
    const sanitized = sanitizeExcludeParams(hostileExcludes);
    expect(sanitized.allowed).toEqual(['temperature']);
    expect(sanitized.rejected).toContain('custom_include_headers');
    expect(sanitized.rejected).toContain('reverse_proxy');

    const customBody = build({ reasoningEffort: 'high', excludeParams: hostileExcludes });
    expect(customBody.temperature).toBeUndefined();
    expect(customBody.chat_completion_source).toBe('custom');
    expect(customBody.custom_url).toBe('https://api.example.com/v1');
    expect(JSON.parse(customBody.custom_include_headers as string)).toEqual({
      Authorization: 'Bearer k',
    });
    expect(JSON.parse(customBody.custom_include_body as string)).toEqual({
      reasoning_effort: 'high',
    });
    expect(customBody.model).toBe('m');
    expect(customBody.messages).toEqual(msgs);
    expect(customBody.stream).toBe(false);

    const openaiBody = build({ excludeParams: hostileExcludes });
    expect(openaiBody.temperature).toBeUndefined();
    expect(openaiBody.chat_completion_source).toBe('openai');
    expect(openaiBody.reverse_proxy).toBe('https://api.example.com/v1');
    expect(openaiBody.proxy_password).toBe('k');
    expect(openaiBody.model).toBe('m');
    expect(openaiBody.messages).toEqual(msgs);
  });

  it('excludeParams 排除 reasoning_effort 时自动回退 openai 源且不发空 custom_include_body', () => {
    const body = build({
      reasoningEffort: 'high',
      excludeParams: ['reasoning_effort'],
    });
    expect(body.chat_completion_source).toBe('openai');
    expect(body.reverse_proxy).toBe('https://api.example.com/v1');
    expect(body.proxy_password).toBe('k');
    expect(body.custom_include_body).toBeUndefined();
  });

  it('拒绝空地址、非 http(s)、内嵌凭据、查询串与锚点，并规范化后缀', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          getRequestHeaders: () => ({}),
        }),
      },
      setTimeout,
      clearTimeout,
    });

    for (const badUrl of [
      '',
      '   ',
      '/v1',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?api_key=leak',
      'https://api.example.com/v1#frag',
    ]) {
      expect(() => buildRequestBody({ ...channel, url: badUrl }, msgs, badUrl)).toThrow();
      await expect(requestCompletion({ ...channel, url: badUrl }, msgs)).rejects.toThrow();
      await expect(fetchModels({ url: badUrl, key: 'k', timeoutSec: 10 })).rejects.toThrow();
      const testRes = await testChannel({ ...channel, url: badUrl });
      expect(testRes.ok).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(requireValidSideChannelBaseUrl('https://api.example.com/v1/chat/completions/')).toBe(
      'https://api.example.com/v1',
    );
    expect(requireValidSideChannelBaseUrl('https://api.example.com/openai/models')).toBe(
      'https://api.example.com/openai',
    );
    expect(normalizeSideChannelBaseUrl('https://api.example.com/chat/completions')).toBe(
      'https://api.example.com',
    );
    expect(normalizeSideChannelBaseUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1',
    );
  });
});

describe('P-1：HTTP 200 错误信封与 SSE 尾部刷新/JSON 回退', () => {
  const msgs = [{ role: 'user' as const, content: '测试' }];

  function stubStWindow(): void {
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
        }),
      },
      setTimeout,
      clearTimeout,
    });
  }

  it('非流式 HTTP 200 { error } 抛出真实错误，且 404 错误在 testChannel 下自动回退切换 /v1', async () => {
    stubStWindow();
    const seenProxies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        seenProxies.push(body.reverse_proxy);
        if (body.reverse_proxy === 'https://api.example.com/gw') {
          return new Response(
            JSON.stringify({ error: { message: '404 page not found' }, quota_error: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await expect(
      requestCompletion({ ...channel, url: 'https://api.example.com/gw', stream: false }, msgs),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: expect.stringContaining('404 page not found'),
    });

    seenProxies.length = 0;
    const res = await testChannel({
      ...channel,
      url: 'https://api.example.com/gw',
      stream: false,
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('连通正常，已改用：https://api.example.com/gw/v1');
    expect(seenProxies).toEqual(['https://api.example.com/gw', 'https://api.example.com/gw/v1']);
  });

  it('流式模式 EOF 无尾随换行仍能完整提取增量文本，遇纯 JSON 错误/结果自动回退解析', async () => {
    stubStWindow();
    const encoder = new TextEncoder();

    // 1. 最后一帧 SSE 没有换行符
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n'));
            ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"后半"}}]}'));
            ctrl.close();
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    await expect(
      requestCompletion({ ...channel, stream: true }, msgs),
    ).resolves.toBe('前半后半');

    // 2. stream: true 但上游直接返回 HTTP 200 JSON { error }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: '额度已耗尽' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(requestCompletion({ ...channel, stream: true }, msgs)).rejects.toThrow(
      new ApiError('副 API 返回错误：额度已耗尽'),
    );
  });
});
