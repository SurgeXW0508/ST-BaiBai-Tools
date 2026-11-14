import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanStoryContextText,
  collectRewriteStoryContext,
  selectHistoryIndices,
  serializeRewriteHistory,
} from '@pen/api/storyContext';
import type { STContext, STMessage } from '@pen/st/context';

const contextMocks = vi.hoisted(() => ({
  getCheckWorldInfo: vi.fn(),
  getContext: vi.fn(),
  getEjsTemplate: vi.fn(),
}));

vi.mock('@pen/st/context', async importOriginal => {
  const actual = await importOriginal<typeof import('@pen/st/context')>();
  return {
    ...actual,
    ...contextMocks,
  };
});

function message(mes: string, options: Partial<STMessage> = {}): STMessage {
  return {
    name: options.is_user ? 'User' : 'Char',
    is_user: false,
    is_system: false,
    mes,
    ...options,
  };
}

describe('story context cleanup', () => {
  it('removes think, thinking, thinging, and HTML comment blocks', () => {
    expect(
      cleanStoryContextText(
        [
          '<think>推理一</think>',
          '<thinking mode="private">推理二</thinking>',
          '<thinging>拼写变体</thinging>',
          '<!-- 隐藏注释 -->',
          '有效正文',
        ].join('\n'),
      ),
    ).toBe('有效正文');
  });

  it('removes an unfinished thinking block', () => {
    expect(cleanStoryContextText('有效正文\n<think>未闭合推理')).toBe('有效正文');
  });
});

describe('story history serialization', () => {
  it('includes an ST-hidden AI floor but skips a real system UI message', () => {
    const chat = [
      message('系统提示', {
        name: 'SillyTavern System',
        is_system: true,
        extra: { uses_system_ui: true },
      }),
      message('<think>隐藏推理</think>上一条 AI 正文', {
        is_system: true,
        swipes: ['上一条 AI 正文'],
      }),
      message('剧情推进', { name: 'User', is_user: true }),
      message('当前待改写楼层'),
    ];

    const indices = selectHistoryIndices(chat, 3, 1);
    expect(indices).toEqual([1, 2]);

    expect(serializeRewriteHistory(chat, indices, 'User', 'Char')).toEqual({
      historyReference: '[楼层 #1｜Char｜ST 隐藏]\n上一条 AI 正文',
      latestUserMessage: '剧情推进',
      messageCount: 2,
    });
  });

  it('combines older turns into one reference and keeps only the latest user separately', () => {
    const chat = [
      message('AI 一'),
      message('用户一', { name: 'User', is_user: true }),
      message('AI 二'),
      message('用户二', { name: 'User', is_user: true }),
      message('当前待改写楼层'),
    ];

    const indices = selectHistoryIndices(chat, 4, 2);
    const history = serializeRewriteHistory(chat, indices, 'User', 'Char', 4);

    expect(history.historyReference).toContain('[楼层 #0｜Char]\nAI 一');
    expect(history.historyReference).toContain('[楼层 #1｜User]\n用户一');
    expect(history.historyReference).toContain('[楼层 #2｜Char]\nAI 二');
    expect(history.latestUserMessage).toBe('用户二');
    expect(history.messageCount).toBe(4);
  });

  it('retains opening greeting [#0 Greeting, #1 User] and preceding AI turn when rewriting a User floor without mislabeling latestUserMessage', () => {
    const greetingChat = [
      message('欢迎来到冒险公会！'),
      message('我想接取委托', { name: 'User', is_user: true }),
    ];
    const greetingIndices = selectHistoryIndices(greetingChat, 1, 1);
    expect(greetingIndices).toEqual([0]);
    expect(serializeRewriteHistory(greetingChat, greetingIndices, 'User', 'Char', 1)).toEqual({
      historyReference: '[楼层 #0｜Char]\n欢迎来到冒险公会！',
      latestUserMessage: '',
      messageCount: 1,
    });

    const fourFloorChat = [
      message('AI1'),
      message('User1', { name: 'User', is_user: true }),
      message('AI2'),
      message('User2', { name: 'User', is_user: true }),
    ];
    const userFloorIndices = selectHistoryIndices(fourFloorChat, 3, 1);
    expect(userFloorIndices).toEqual([1, 2]);
    const serialized = serializeRewriteHistory(fourFloorChat, userFloorIndices, 'User', 'Char', 3);
    expect(serialized.historyReference).toContain('[楼层 #1｜User]\nUser1');
    expect(serialized.historyReference).toContain('[楼层 #2｜Char]\nAI2');
    expect(serialized.latestUserMessage).toBe('');
    expect(serialized.messageCount).toBe(2);
  });

  it('guards undefined message.name and collects contiguous multi-AI group turns cleanly', () => {
    const groupChat: STMessage[] = [
      message('大家怎么看？', { name: 'User', is_user: true }),
      { name: undefined as unknown as string, is_user: false, is_system: false, mes: '无名路人插话' },
      message('我也同意', { name: 'Bob', is_user: false }),
      message('待改写回复', { name: 'Alice', is_user: false }),
    ];

    const indices = selectHistoryIndices(groupChat, 3, 1);
    expect(indices).toEqual([0, 1, 2]);
    const history = serializeRewriteHistory(groupChat, indices, 'User', 'Char', 3);
    expect(history.historyReference).toContain('[楼层 #1｜Char]\n无名路人插话');
    expect(history.historyReference).toContain('[楼层 #2｜Bob]\n我也同意');
    expect(history.latestUserMessage).toBe('');
  });
});

describe('optional story context', () => {
  const substituteParams = vi.fn((content: string) =>
    content === '{{persona}}' ? 'User persona' : `expanded:${content}`,
  );
  const checkWorldInfo = vi.fn(async () => ({
    allActivatedEntries: new Set([{ content: 'world entry' }]),
  }));
  const context: STContext = {
    chat: [message('current floor')],
    name1: 'User',
    name2: 'Char',
    characters: [
      {
        name: 'Char',
        avatar: 'char.png',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
      },
    ],
    characterId: 0,
    getRequestHeaders: () => ({}),
    substituteParams,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    contextMocks.getContext.mockReturnValue(context);
    contextMocks.getCheckWorldInfo.mockResolvedValue(checkWorldInfo);
    contextMocks.getEjsTemplate.mockReturnValue(null);
  });

  it('skips disabled world info, character description, and User information', async () => {
    const result = await collectRewriteStoryContext(0, 'current floor', 0, {
      includeWorldInfo: false,
      includeCharacterDescription: false,
      includeUserDescription: false,
    });

    expect(result.worldInfo).toBe('');
    expect(result.charCard).toBe('');
    expect(result.persona).toBe('');
    expect(contextMocks.getCheckWorldInfo).not.toHaveBeenCalled();
    expect(substituteParams).not.toHaveBeenCalled();
  });

  it('collects all three optional context parts when enabled', async () => {
    const result = await collectRewriteStoryContext(0, 'current floor', 0, {
      includeWorldInfo: true,
      includeCharacterDescription: true,
      includeUserDescription: true,
    });

    expect(result.worldInfo).toBe('expanded:world entry');
    expect(result.charCard).toContain('expanded:description');
    expect(result.charCard).toContain('expanded:personality');
    expect(result.charCard).toContain('expanded:scenario');
    expect(result.persona).toBe('User persona');
    expect(contextMocks.getCheckWorldInfo).toHaveBeenCalledOnce();
  });

  it('orders World Info scanText newest-first (target floor at depth 0) with true speaker labels', async () => {
    const capturedScanChats: string[][] = [];
    contextMocks.getCheckWorldInfo.mockResolvedValue(async (scanChat: string[]) => {
      capturedScanChats.push(scanChat);
      return { allActivatedEntries: new Set() };
    });

    const multiTurnContext: STContext = {
      ...context,
      chat: [
        message('第一轮 AI 回复'),
        message('第一轮用户提问', { name: '主角', is_user: true }),
        message('第二轮 AI 回复'),
        message('第二轮用户提问', { name: '主角', is_user: true }),
        message('第二轮 AI 终稿'),
      ],
    };
    contextMocks.getContext.mockReturnValue(multiTurnContext);

    await collectRewriteStoryContext(4, '正在改写的第二轮 AI 终稿', 2);
    await collectRewriteStoryContext(3, '正在改写的第二轮用户提问', 2);

    expect(capturedScanChats).toHaveLength(2);
    expect(capturedScanChats[0]).toEqual([
      'Char: 正在改写的第二轮 AI 终稿',
      '主角: 第二轮用户提问',
      'Char: 第二轮 AI 回复',
      '主角: 第一轮用户提问',
      'Char: 第一轮 AI 回复',
    ]);
    expect(capturedScanChats[1]).toEqual([
      '主角: 正在改写的第二轮用户提问',
      'Char: 第二轮 AI 回复',
      '主角: 第一轮用户提问',
      'Char: 第一轮 AI 回复',
    ]);
  });

  it('snapshots and restores extensionPrompts["2_floating_prompt"] and skips restore on mid-scan chat switch', async () => {
    const filterFn = () => true;
    const extensionPrompts: STContext['extensionPrompts'] = {
      '2_floating_prompt': {
        value: '原始作者注释',
        position: 1,
        depth: 4,
        filter: filterFn,
      },
    };
    contextMocks.getContext.mockReturnValue({
      ...context,
      getCurrentChatId: () => 'chat-1',
      extensionPrompts,
    });
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      extensionPrompts['2_floating_prompt'] = {
        value: '被 ANTop 污染的注释\n原始作者注释',
        position: 1,
        depth: 4,
      };
      return { allActivatedEntries: new Set([{ content: 'wi-entry' }]) };
    });

    const res = await collectRewriteStoryContext(0, 'current floor', 0);
    expect(res.worldInfo).toBe('expanded:wi-entry');
    expect(extensionPrompts['2_floating_prompt']).toEqual({
      value: '原始作者注释',
      position: 1,
      depth: 4,
      filter: filterFn,
    });

    // 初始不存在 2_floating_prompt 时，干跑前绝不预写空占位污染其它读取者，干跑残留结束后彻底移除
    const emptyPrompts: STContext['extensionPrompts'] = {};
    let sawTempPlaceholder = false;
    contextMocks.getContext.mockReturnValue({
      ...context,
      getCurrentChatId: () => 'chat-1',
      extensionPrompts: emptyPrompts,
    });
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      sawTempPlaceholder = '2_floating_prompt' in emptyPrompts;
      emptyPrompts['2_floating_prompt'] = { value: '干跑残留' };
      return { allActivatedEntries: new Set() };
    });

    await collectRewriteStoryContext(0, 'current floor', 0);
    expect(sawTempPlaceholder).toBe(false);
    expect('2_floating_prompt' in emptyPrompts).toBe(false);

    // 干跑中途切卡后，绝不把旧卡快照回写覆盖新卡的 extensionPrompts
    const sharedPrompts: STContext['extensionPrompts'] = {
      '2_floating_prompt': { value: 'A卡注释', position: 1, depth: 4 },
    };
    let activeChatId = 'chat-a';
    contextMocks.getContext.mockImplementation(() => ({
      ...context,
      getCurrentChatId: () => activeChatId,
      extensionPrompts: sharedPrompts,
    }));
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      activeChatId = 'chat-b';
      sharedPrompts['2_floating_prompt'] = { value: 'B卡自己的新注释', position: 1, depth: 4 };
      return { allActivatedEntries: new Set() };
    });

    await collectRewriteStoryContext(0, 'current floor', 0);
    expect(sharedPrompts['2_floating_prompt']?.value).toBe('B卡自己的新注释');

    // 干跑期间若有外部并发逻辑把 2_floating_prompt 改成了全新注释（非包含原值的 ANTop/ANBottom 拼接），finally 绝不倒退覆盖
    const concurrentPrompts: STContext['extensionPrompts'] = {
      '2_floating_prompt': { value: '旧注释', position: 1, depth: 4 },
    };
    contextMocks.getContext.mockReturnValue({
      ...context,
      getCurrentChatId: () => 'chat-1',
      extensionPrompts: concurrentPrompts,
    });
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      concurrentPrompts['2_floating_prompt'] = { value: '用户并发保存的全新注释', position: 1, depth: 2 };
      return { allActivatedEntries: new Set() };
    });

    await collectRewriteStoryContext(0, 'current floor', 0);
    expect(concurrentPrompts['2_floating_prompt']).toEqual({
      value: '用户并发保存的全新注释',
      position: 1,
      depth: 2,
    });

    // 干跑期间若宿主开始正式流式生成（isChatStreaming 为 true），finally 绝不触碰 extensionPrompts
    const streamPrompts: STContext['extensionPrompts'] = {
      '2_floating_prompt': { value: '干跑前注释', position: 1, depth: 4 },
    };
    let streamingProcessor: STContext['streamingProcessor'] = null;
    contextMocks.getContext.mockImplementation(() => ({
      ...context,
      getCurrentChatId: () => 'chat-1',
      streamingProcessor,
      extensionPrompts: streamPrompts,
    }));
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      streamingProcessor = { isFinished: false };
      streamPrompts['2_floating_prompt'] = { value: '正式生成期间注释\n干跑前注释', position: 1, depth: 4 };
      return { allActivatedEntries: new Set() };
    });

    await collectRewriteStoryContext(0, 'current floor', 0);
    expect(streamPrompts['2_floating_prompt']?.value).toBe('正式生成期间注释\n干跑前注释');
  });

  it('skips checkWorldInfo and getWorldInfoPrompt completely when ST is actively streaming', async () => {
    const checkSpy = vi.fn(async () => ({ allActivatedEntries: new Set([{ content: '不应触发' }]) }));
    const promptSpy = vi.fn(async () => ({ worldInfoString: '不应触发' }));
    contextMocks.getCheckWorldInfo.mockResolvedValue(checkSpy);
    contextMocks.getContext.mockReturnValue({
      ...context,
      getWorldInfoPrompt: promptSpy,
      streamingProcessor: { isFinished: false },
    });

    const result = await collectRewriteStoryContext(0, 'current floor', 0, {
      includeWorldInfo: true,
      includeCharacterDescription: true,
      includeUserDescription: false,
    });

    expect(result.worldInfo).toBe('');
    expect(result.charCard).toContain('expanded:description');
    expect(checkSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('prioritizes baibai_exclude_settings over legacy baibai_book exclude lists', async () => {
    contextMocks.getContext.mockReturnValue({
      ...context,
      extensionSettings: {
        baibai_exclude_settings: {
          excludedWorldNames: ['shared-blocked-world'],
          excludedWorldInfoPatterns: ['^status-bar$'],
        },
        baibai_book: {
          excludedWorldNames: ['legacy-only-world'],
          excludedWorldInfoPatterns: [],
          renderWorldInfoTemplates: false,
        },
      },
    });
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => ({
      allActivatedEntries: new Set([
        { world: 'shared-blocked-world', comment: 'lore', content: '不应包含1' },
        { world: 'allowed-world', comment: 'status-bar', content: '不应包含2' },
        { world: 'legacy-only-world', comment: 'keep', content: '应保留正文' },
      ]),
    }));

    const result = await collectRewriteStoryContext(0, 'current floor', 0, {
      includeWorldInfo: true,
      includeCharacterDescription: false,
      includeUserDescription: false,
    });
    expect(result.worldInfo).toBe('应保留正文');
  });
});
