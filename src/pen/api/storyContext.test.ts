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
    const history = serializeRewriteHistory(chat, indices, 'User', 'Char');

    expect(history.historyReference).toContain('[楼层 #0｜Char]\nAI 一');
    expect(history.historyReference).toContain('[楼层 #1｜User]\n用户一');
    expect(history.historyReference).toContain('[楼层 #2｜Char]\nAI 二');
    expect(history.latestUserMessage).toBe('用户二');
    expect(history.messageCount).toBe(4);
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
      '主角: 第一轮用户提问',
      'Char: 第一轮 AI 回复',
    ]);
  });

  it('snapshots and restores extensionPrompts["2_floating_prompt"] mutated during dry-run WI scan', async () => {
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

    // 初始不存在 2_floating_prompt 时，干跑新增的槽位也应被彻底移除
    const emptyPrompts: STContext['extensionPrompts'] = {};
    contextMocks.getContext.mockReturnValue({
      ...context,
      extensionPrompts: emptyPrompts,
    });
    contextMocks.getCheckWorldInfo.mockResolvedValue(async () => {
      emptyPrompts['2_floating_prompt'] = { value: '干跑残留' };
      return { allActivatedEntries: new Set() };
    });

    await collectRewriteStoryContext(0, 'current floor', 0);
    expect('2_floating_prompt' in emptyPrompts).toBe(false);
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
