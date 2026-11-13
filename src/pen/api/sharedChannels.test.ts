import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  channels,
  initializeSharedChannels,
  resetSharedChannelsStateForTests,
  saveSharedChannel,
  teardownSharedChannels,
} from '@pen/api/sharedChannels';

interface FakeWindowTarget {
  listeners: Map<string, Set<EventListener>>;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  dispatchEvent: (event: Event) => boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

function createFakeWindow(): FakeWindowTarget {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    listeners,
    addEventListener(type: string, listener: EventListener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
    setTimeout,
    clearTimeout,
  };
}

function installHost(extensionSettings: Record<string, unknown>, fakeWindow: FakeWindowTarget) {
  const saveSettingsDebounced = vi.fn();
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('SillyTavern', {
    getContext: () => ({
      extensionSettings,
      saveSettingsDebounced,
      getRequestHeaders: () => ({}),
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
  return { saveSettingsDebounced };
}

beforeEach(() => {
  resetSharedChannelsStateForTests();
});

afterEach(() => {
  resetSharedChannelsStateForTests();
  vi.unstubAllGlobals();
});

describe('sharedChannels consumer-mode hydration and migration', () => {
  it('does not write an empty baibai_api_channels store when no legacy channels exist', async () => {
    const extensionSettings: Record<string, unknown> = {};
    const fakeWindow = createFakeWindow();
    const { saveSettingsDebounced } = installHost(extensionSettings, fakeWindow);

    await initializeSharedChannels();

    expect(channels).toEqual([]);
    expect('baibai_api_channels' in extensionSettings).toBe(false);
    expect(saveSettingsDebounced).not.toHaveBeenCalled();

    saveSharedChannel({
      id: 'ch_first',
      name: '首个副渠道',
      url: 'https://api.example.com/v1',
      key: 'sk-test',
      model: 'gpt-4o-mini',
      temperature: 0.8,
      maxTokens: 4096,
      timeoutSec: 60,
      stream: false,
      prefill: true,
      excludeParams: ['temperature', 'custom_include_headers'],
      reasoningEffort: '',
    });

    expect(extensionSettings.baibai_api_channels).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      channels: [
        expect.objectContaining({
          id: 'ch_first',
          excludeParams: ['temperature'],
        }),
      ],
    });
  });

  it('seeds shared store from both baibai_book and baibai_image channels deduplicated by id', async () => {
    const extensionSettings: Record<string, unknown> = {
      baibai_book: {
        channels: [
          { id: 'ch_book', name: '书渠道', url: 'https://book.example.com/v1', key: 'k1', model: 'm1' },
          { id: 'ch_dup', name: '书优先', url: 'https://book2.example.com/v1', key: 'k2', model: 'm2' },
        ],
      },
      baibai_image: {
        channels: [
          { id: 'ch_dup', name: '绘重名', url: 'https://img.example.com/v1', key: 'k3', model: 'm3' },
          { id: 'ch_image', name: '绘渠道', url: 'https://img2.example.com/v1', key: 'k4', model: 'm4' },
        ],
      },
    };
    const fakeWindow = createFakeWindow();
    installHost(extensionSettings, fakeWindow);

    await initializeSharedChannels();

    expect(channels.map(item => `${item.id}:${item.name}`)).toEqual([
      'ch_book:书渠道',
      'ch_dup:书优先',
      'ch_image:绘渠道',
    ]);
    expect(extensionSettings.baibai_api_channels).toMatchObject({
      schemaVersion: 1,
      revision: 1,
    });
  });

  it('self-heals an empty revision<=1 placeholder store from baibai_image while respecting revision>=2 user deletion', async () => {
    const extensionSettings: Record<string, unknown> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 1,
        channels: [],
      },
      baibai_image: {
        channels: [
          { id: 'ch_img', name: '柏宝绘存量渠道', url: 'https://img.example.com/v1', key: 'k', model: 'm' },
        ],
      },
    };
    const fakeWindow = createFakeWindow();
    installHost(extensionSettings, fakeWindow);

    await initializeSharedChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe('ch_img');
    expect((extensionSettings.baibai_api_channels as { revision: number }).revision).toBe(2);

    // 用户主动新增后再删空（revision = 2）不应被旧配置反向复活
    resetSharedChannelsStateForTests();
    const deletedSettings: Record<string, unknown> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 2,
        channels: [],
      },
      baibai_image: {
        channels: [
          { id: 'ch_img', name: '旧残余', url: 'https://img.example.com/v1', key: 'k', model: 'm' },
        ],
      },
    };
    installHost(deletedSettings, fakeWindow);

    await initializeSharedChannels();
    expect(channels).toEqual([]);
  });

  it('sanitizes legacy disallowed excludeParams in shared store and unbinds/rebinds event listener cleanly', async () => {
    const extensionSettings: Record<string, unknown> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 3,
        channels: [
          {
            id: 'ch_dirty',
            name: '旧污染渠道',
            url: 'https://api.example.com/v1',
            key: 'k',
            model: 'm',
            excludeParams: ['custom_include_headers', 'reverse_proxy', 'top_p'],
          },
        ],
      },
    };
    const fakeWindow = createFakeWindow();
    installHost(extensionSettings, fakeWindow);

    await initializeSharedChannels();
    expect(channels[0]?.excludeParams).toEqual(['top_p']);
    expect(
      (extensionSettings.baibai_api_channels as { channels: Array<{ excludeParams: string[] }> })
        .channels[0]?.excludeParams,
    ).toEqual(['top_p']);
    expect(fakeWindow.listeners.get('st-baibai-api-channels:changed')?.size).toBe(1);

    teardownSharedChannels();
    expect(fakeWindow.listeners.get('st-baibai-api-channels:changed')?.size ?? 0).toBe(0);

    // 停用期间外部插件写入新渠道，重新启用时应重新绑定并同步
    extensionSettings.baibai_api_channels = {
      schemaVersion: 1,
      revision: 5,
      channels: [
        {
          id: 'ch_external',
          name: '外部新增渠道',
          url: 'https://ext.example.com/v1',
          key: 'k2',
          model: 'm2',
          excludeParams: [],
        },
      ],
    };
    await initializeSharedChannels();
    expect(fakeWindow.listeners.get('st-baibai-api-channels:changed')?.size).toBe(1);
    expect(channels.map(item => item.id)).toEqual(['ch_external']);
  });

  it('maintains monotonic revision against external store bumps and clears waitTimer on teardown', async () => {
    const extensionSettings: Record<string, unknown> = {
      baibai_api_channels: {
        schemaVersion: 1,
        revision: 2,
        channels: [],
      },
    };
    const fakeWindow = createFakeWindow();
    installHost(extensionSettings, fakeWindow);

    await initializeSharedChannels();

    // 模拟另一插件直接把底层存储 revision 升到了 10 但尚未派发事件
    extensionSettings.baibai_api_channels = {
      schemaVersion: 1,
      revision: 10,
      channels: [],
    };

    saveSharedChannel({
      id: 'ch_mono',
      name: '单调递增测试',
      url: 'https://api.example.com/v1',
      key: 'k',
      model: 'm',
      temperature: 1,
      maxTokens: 1024,
      timeoutSec: 30,
      stream: false,
      prefill: true,
      excludeParams: [],
      reasoningEffort: '',
    });

    expect((extensionSettings.baibai_api_channels as { revision: number }).revision).toBe(11);

    // 验证等待 extensionSettings 期间调用 teardownSharedChannels 立即清理定时器
    resetSharedChannelsStateForTests();
    const clearSpy = vi.fn(clearTimeout);
    vi.stubGlobal('window', {
      ...createFakeWindow(),
      clearTimeout: clearSpy,
    });
    vi.stubGlobal('SillyTavern', {
      getContext: () => ({}),
    });
    const waitInit = initializeSharedChannels();
    teardownSharedChannels();
    await waitInit;
    expect(clearSpy).toHaveBeenCalled();
  });
});
