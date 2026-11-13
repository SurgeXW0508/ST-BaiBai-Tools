import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import * as chatConstants from '../src/chat/constants.js';
import * as generateRequest from '../src/features/generateRequest.js';
import * as scrollTopPatch from '../src/scrollTopPatch.js';
import * as worldInfoConstants from '../src/worldinfo/constants.js';

const featureConstants = {
    CURRENT_VERSION: '1.1.5',
    LOG_PREFIX: '[test]',
    BAIBAOKU_EXTENSIONS_URL: '/api/plugins/baibaoku/v1/extensions',
    BAIBAOKU_SAVE_GENERATE_URL: '/api/plugins/baibaoku/v1/chats/save-generate',
    EXTENSION_DELETE_PATH: '/api/extensions/delete',
    EXTENSION_INSTALL_PATH: '/api/extensions/install',
    EXTENSION_UPDATE_PATH: '/api/extensions/update',
    EXTENSION_OPS_CODE_HEADER: 'x-baibaoku-extension-code',
    EXTENSION_OPS_FETCH_KEY: '__baiBaiToolkitExtensionOpsFetch',
    EXTENSION_OPS_JOB_HEADER: 'x-baibaoku-job',
    EXTENSION_OPS_NOTICE_REPLAY_MS: 60_000,
    EXTENSION_OPS_NOTICES_STORAGE_KEY: 'bbt_notices',
    EXTENSION_OPS_OP_HEADER: 'x-baibaoku-extension-op',
    EXTENSION_OPS_PENDING_STORAGE_KEY: 'bbt_pending',
    EXTENSION_OPS_POLL_INTERVAL_MS: 1000,
    EXTENSION_OPS_PROGRESS_DELAY_MS: 1200,
    EXTENSION_OPS_RESUME_MAX_AGE_MS: 300_000,
    EXTENSION_VERSION_CHECK_TIMEOUT_MS: 5000,
    GENERATE_BLACKLIST_MAX_RETRIES: 3,
    GENERATE_BLACKLIST_SETTLED_EVENT: 'bai_bai_toolkit_blacklist_settled',
    GENERATE_BLACKLIST_WAIT_POLL_MS: 10,
    GENERATE_BLACKLIST_WAIT_TIMEOUT_MS: 100,
    GENERATE_RETRY_BASE_DELAY_MS: 5,
    GENERATE_RETRY_DEFAULT_RETRIES: 3,
    GENERATE_RETRY_FETCH_KEY: '__baiBaiToolkitGenerateRetryFetch',
    GENERATE_RETRY_MAX_DELAY_MS: 20,
    GENERATE_RETRY_MAX_RETRIES: 10,
    GENERATE_RETRY_MESSAGE_TYPES: new Set(['normal', 'regenerate', 'swipe', 'continue']),
    GENERATE_RETRY_MIN_RETRIES: 1,
    GENERATE_RETRY_PATHS: new Set(['/api/backends/chat-completions/generate']),
    GENERATE_RETRY_PERMANENT_STATUSES: new Set([400, 401, 403, 404, 422]),
    GENERATE_RETRY_REASON_MAX_LENGTH: 120,
};

const presetConstants = {
    BAIBAOKU_TOKENIZER_BULK_COUNT_URL: '/api/plugins/baibaoku/v1/tokenizer/openai/count-bulk',
    OPENAI_TOKENIZER_BULK_AJAX_BATCH_DELAY_MS: 5,
    OPENAI_TOKENIZER_BULK_BRIDGE_KEY: '__baibaokuOpenAITokenizerBridge',
    OPENAI_TOKENIZER_BULK_CACHE_LIMIT: 500,
    OPENAI_TOKENIZER_BULK_CIRCUIT_BREAKER_MS: 30_000,
    OPENAI_TOKENIZER_BULK_FAILURE_THRESHOLD: 3,
    OPENAI_TOKENIZER_BULK_PREPARE_CHUNK_SIZE: 64,
    OPENAI_TOKENIZER_BULK_PREPARE_MAX_MESSAGES: 128,
    PRESET_CONTEXT_TOKEN_REFRESH_SELF_SUPPRESS_MS: 50,
    PRESET_PROMPT_MANAGER_LIST_SELECTOR: '#completion_prompt_manager_list',
    PROMPT_MANAGER_TOKEN_REFRESH_BUSY_DELAY_MS: 50,
    PROMPT_MANAGER_TOKEN_REFRESH_DEFAULT_DELAY_MS: 20,
    PROMPT_MANAGER_TOKEN_REFRESH_FAST_DELAY_MS: 5,
    PROMPT_MANAGER_TOKEN_REFRESH_QUEUE_KEY: '__bbtQueue',
};

const gzipHook = {
    buildFetchHeaders: (input, init) => new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)),
    getFetchRequestMethod: (input, init) => String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
    getFetchRequestUrl: input => (input instanceof Request ? input.url : String(input ?? '')),
    isFetchRequest: input => input instanceof Request,
};

const featureUtil = {
    readFetchJsonBody: async (input, init) => {
        try {
            return JSON.parse(init?.body ?? await input.clone().text());
        } catch {
            return null;
        }
    },
};

async function loadVmModule(relPath, context, mocks = {}) {
    const fileUrl = new URL(relPath, import.meta.url);
    const code = await readFile(fileUrl, 'utf8');
    const imports = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .filter(node => node.type === 'ImportDeclaration');
    const dependencies = new Map();
    const mod = new vm.SourceTextModule(code, {
        context,
        identifier: relPath,
        initializeImportMeta: meta => {
            meta.url = 'https://isolated.invalid/scripts/extensions/third-party/ST-BaiBai-Tools/dist/index.js';
        },
    });
    await mod.link(source => {
        if (!dependencies.has(source)) {
            const values = mocks[source] || {};
            const names = new Set(Object.keys(values));
            for (const entry of imports.filter(item => item.source.value === source)) {
                for (const specifier of entry.specifiers) {
                    if (specifier.type === 'ImportSpecifier') names.add(specifier.imported.name);
                    if (specifier.type === 'ImportDefaultSpecifier') names.add('default');
                }
            }
            dependencies.set(source, new vm.SyntheticModule([...names], function () {
                for (const name of names) this.setExport(name, values[name]);
            }, { context }));
        }
        return dependencies.get(source);
    });
    await mod.evaluate();
    return mod.namespace;
}

// Exercise the actual settings lifecycle without a live ST account or saved chats.
for (const initial of [undefined, false, true]) for (const migrated of [false, true]) {
    test(`Save Generate stays off across legacy settings and reinitialization: enabled=${initial}, migrated=${migrated}`, async () => {
        const stored = { saveGenerateEnabled: initial, saveGenerateDefaultEnabledMigrated: migrated, generateRetryEnabled: true };
        const extension_settings = { baiBaiToolkit: stored };
        let saves = 0;
        const context = vm.createContext({ URL, console });
        const state = await loadVmModule('../src/features/state.js', context, {
            '@sillytavern/script': { saveSettingsDebounced: () => saves++ },
            '@sillytavern/scripts/extensions': { extension_settings },
            './constants.js': { EXTENSION_KEY: '__personalStableTest', SETTINGS_KEY: 'baiBaiToolkit' },
        });
        state.initializeSettings();
        assert.equal(state.settings.saveGenerateEnabled, false);
        assert.equal(stored.saveGenerateEnabled, false);
        assert.equal(state.settings.generateRetryEnabled, true, 'Unrelated settings must remain unchanged');
        stored.saveGenerateEnabled = true;
        state.initializeSettings();
        assert.equal(state.settings.saveGenerateEnabled, false);
        assert.equal(stored.saveGenerateEnabled, false);
        assert.ok(saves > 0);
    });
}

test('WP-T-2: World Info tokenizer prewarm only runs for openai, stops at macros, and rejects multimodal/tool_calls', async () => {
    let fetchCalls = 0;
    const scriptState = { main_api: 'claude', getRequestHeaders: () => ({}), getCurrentChatId: () => 'chat-1' };
    const context = vm.createContext({
        URL,
        Headers,
        Map,
        Set,
        console,
        location: new URL('http://localhost:8000/'),
        fetch: async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ ok: true, data: { counts: [10, 20] } }), { status: 200 });
        },
    });
    const scriptProxy = new Proxy(scriptState, {
        get(target, prop) {
            return target[prop];
        },
    });
    const tokenizer = await loadVmModule('../src/preset/tokenizer.js', context, {
        '@sillytavern/script': {
            get main_api() { return scriptProxy.main_api; },
            getRequestHeaders: () => ({}),
            getCurrentChatId: () => 'chat-1',
        },
        '@sillytavern/scripts/openai': { oai_settings: {}, promptManager: {} },
        '@sillytavern/scripts/tokenizers': { getTokenizerModel: () => 'gpt-4o' },
        '@sillytavern/scripts/utils': { getStringHash: text => String(text).length },
        './constants.js': presetConstants,
        './saveToggle.js': { updatePromptTokenCell() {} },
        './state.js': { LOG_PREFIX: '[test]', extensionState: {}, settings: { tokenizerBulkCountEnabled: true } },
        './switchFast.js': {},
        './util.js': { isPresetGenerationActive: () => false },
        './vueList.js': { isPresetVuePromptListDragging: () => false },
        './vueModel.js': {},
    });

    // Non-openai API must skip bulk prewarm completely.
    const skipped = await tokenizer.prepareOpenAITokenizerWorldInfoBudgetCounts({
        textToScan: 'hello world',
        entries: [{ content: 'plain entry', maySkip: false }],
    });
    assert.equal(skipped, false);
    assert.equal(fetchCalls, 0);

    // OpenAI API stops prewarming at macro-bearing entries.
    scriptState.main_api = 'openai';
    const collected = tokenizer.collectOpenAITokenizerWorldInfoBudgetMessages({
        textToScan: '',
        entries: [
            { content: 'first plain', maySkip: false },
            { content: 'roll {{roll:1d20}}', maySkip: false },
            { content: 'after macro', maySkip: false },
        ],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(collected)), [{ role: 'system', content: 'first plain\n' }]);

    // Multimodal arrays and tool_calls return null instead of coercing to "[object Object]".
    assert.equal(tokenizer.normalizeOpenAITokenizerMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
    }), null);
    assert.equal(tokenizer.normalizeOpenAITokenizerMessage({
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
    }), null);
});

test('WP-T-3: Generate Retry skips JSON parsing when unmarked/disabled and passes Vertex straight through alongside Blacklist Retry', async () => {
    const listeners = new Map();
    const event_types = {
        GENERATION_STARTED: 'GENERATION_STARTED',
        GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
        CHAT_COMPLETION_SETTINGS_READY: 'CHAT_COMPLETION_SETTINGS_READY',
        GENERATE_AFTER_DATA: 'GENERATE_AFTER_DATA',
        CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
        GENERATION_ENDED: 'GENERATION_ENDED',
        GENERATION_STOPPED: 'GENERATION_STOPPED',
        CHAT_CHANGED: 'CHAT_CHANGED',
    };
    const eventSource = {
        on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
        async emit(event, ...args) {
            for (const fn of listeners.get(event) || []) await fn(...args);
        },
    };
    const settings = {
        generateRetryEnabled: false,
        saveGenerateEnabled: false,
        generateBlacklistRetryEnabled: true,
        generateBlacklistRetryText: 'forbidden_token',
    };
    let readJsonCalls = 0;
    let fetchCalls = 0;
    let lastInit = null;
    const contextObj = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'vertexai' },
        chat: [{ is_user: false, mes: 'forbidden_token' }],
        characterId: 0,
        chatId: 'chat-vertex',
    };
    const context = vm.createContext({
        URL,
        Headers,
        Request,
        Response,
        console,
        setTimeout,
        clearTimeout,
        fetch: async (_input, init) => {
            fetchCalls += 1;
            lastInit = init;
            return new Response('Service Unavailable', { status: 503 });
        },
    });

    const retryMod = await loadVmModule('../src/features/generateRetry.js', context, {
        '@sillytavern/script': { event_types, eventSource },
        './generateRequest.js': generateRequest,
        './constants.js': featureConstants,
        './gzipHook.js': gzipHook,
        './generationLifecycle.js': {
            getGenerationStopEpoch: () => 0,
            isCurrentGenerationStopped: () => false,
            subscribeGenerationStop: () => () => {},
        },
        './state.js': { extensionState: {}, settings },
        './util.js': {
            ...featureUtil,
            readFetchJsonBody: async (...args) => {
                readJsonCalls += 1;
                return featureUtil.readFetchJsonBody(...args);
            },
        },
    });
    retryMod.installGenerateRetryFetchHook();

    // 1. Disabled retry: exact init reference and body bytes preserved, zero readFetchJsonBody calls.
    const rawInit = { method: 'POST', body: '{"chat_completion_source":"openai","messages":[{"role":"user","content":"hi"}]}' };
    const res1 = await context.fetch('/api/backends/chat-completions/generate', rawInit);
    assert.equal(res1.status, 503);
    assert.equal(fetchCalls, 1);
    assert.equal(readJsonCalls, 0);
    assert.equal(lastInit, rawInit);

    // 2. Enabled retry + Vertex source: no marker added, zero readFetchJsonBody calls, no retry on 503.
    settings.generateRetryEnabled = true;
    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const vertexPayload = { type: 'normal', chat_completion_source: 'vertexai', messages: [{ role: 'user', content: 'hi' }] };
    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, vertexPayload);
    assert.equal('__baibai_generation_id' in vertexPayload, false);
    const vertexInit = { method: 'POST', body: JSON.stringify(vertexPayload) };
    const res2 = await context.fetch('/api/backends/chat-completions/generate', vertexInit);
    assert.equal(res2.status, 503);
    assert.equal(fetchCalls, 2, 'Vertex 503 must not be retried by BaiBao Generate Retry');
    assert.equal(readJsonCalls, 0, 'Vertex unmarked request must bypass JSON parsing');

    // 3. Blacklist retry ignores Vertex generations even when enabled and matching text.
    let regenerated = 0;
    const blacklistMod = await loadVmModule('../src/features/generateBlacklistRetry.js', context, {
        '@sillytavern/script': {
            event_types,
            eventSource,
            Generate: async () => { regenerated += 1; },
            deleteLastMessage: async () => { regenerated += 1; },
            is_send_press: false,
            streamingProcessor: null,
        },
        '@sillytavern/scripts/extensions': { getContext: () => contextObj },
        './constants.js': featureConstants,
        './generationLifecycle.js': {
            getGenerationStopEpoch: () => 0,
            isCurrentGenerationStopped: () => false,
            subscribeGenerationStop: () => () => {},
        },
        './state.js': { extensionState: {}, settings },
    });
    blacklistMod.installGenerateBlacklistRetry();
    await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
    await eventSource.emit(event_types.GENERATION_ENDED, 0);
    assert.equal(regenerated, 0);
});

test('WP-T-4: extensionOps respects backend interceptEnabled=false and updateCheck resolves personal/stable manifest URL', async () => {
    const calls = [];
    const storage = new Map();
    const context = vm.createContext({
        URL,
        Headers,
        Request,
        Response,
        AbortController,
        crypto,
        console,
        setTimeout,
        clearTimeout,
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, val) => storage.set(key, String(val)),
        },
        sessionStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        },
        fetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            calls.push({ url, init });
            if (url.endsWith('/manager/config')) {
                return new Response(JSON.stringify({ ok: true, data: { interceptEnabled: false, isAdmin: true } }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
    });

    const extensionOps = await loadVmModule('../src/features/extensionOps.js', context, {
        '@sillytavern/script': { event_types: { APP_READY: 'APP_READY' }, eventSource: { once() {} }, getRequestHeaders: () => ({}) },
        '@sillytavern/scripts/popup': { callGenericPopup: async () => 0, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1, TEXT: 2 } },
        './constants.js': featureConstants,
        './gzipHook.js': gzipHook,
        './state.js': { extensionState: {} },
        './updateDiagnostics.js': { hasUserInteracted: () => false },
        './util.js': featureUtil,
    });
    extensionOps.installExtensionOpsFetchHook();

    const updateInit = { method: 'POST', body: JSON.stringify({ extensionName: 'third-party/ST-BaiBai-Tools', global: false }) };
    await context.fetch('/api/extensions/update', updateInit);
    const forwarded = calls.find(entry => entry.url === '/api/extensions/update');
    assert.ok(forwarded);
    assert.equal(forwarded.init, updateInit, 'Native /api/extensions/update must not receive x-baibaoku-job header when interceptEnabled is false');
    assert.equal(calls.some(entry => entry.url.includes('/jobs')), false);

    const updateCheck = await loadVmModule('../src/features/updateCheck.js', context, {
        '@sillytavern/script': { getRequestHeaders: () => ({}) },
        '@sillytavern/scripts/extensions': { extensionTypes: { 'third-party/ST-BaiBai-Tools': 'local' } },
        '@sillytavern/scripts/i18n': { t: strings => strings[0] },
        '@sillytavern/scripts/popup': { callGenericPopup: async () => 0, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 } },
        '@sillytavern/scripts/user': { isAdmin: () => true },
        './constants.js': featureConstants,
        './extensionOps.js': extensionOps,
        './state.js': { EXTENSION_ID: 'ST-BaiBai-Tools', extensionState: {}, settings: {} },
        './updateDiagnostics.js': { showExtensionUpdateDiagnosis: async () => {} },
    });

    assert.equal(
        updateCheck.resolveRemoteManifestUrl(),
        'https://raw.githubusercontent.com/SurgeXW0508/ST-BaiBai-Tools/personal/stable/manifest.json',
    );
    assert.equal(
        updateCheck.resolveRemoteManifestUrl({
            remoteUrl: 'https://github.com/SurgeXW0508/ST-BaiBai-Tools.git',
            currentBranchName: 'personal/stable',
        }),
        'https://raw.githubusercontent.com/SurgeXW0508/ST-BaiBai-Tools/personal/stable/manifest.json',
    );
});

test('WP-T-5 & WP-T-6: scrollTop single owner, Fast Chat no-op, gated backup list fetch, and streamingRegexDefer previewFailed guard', async () => {
    // 1. Single Object.defineProperty owner for scrollTop.
    let defineCount = 0;
    let backingScrollTop = 0;
    const proto = {};
    Object.defineProperty(proto, 'scrollTop', {
        configurable: true,
        get() { return backingScrollTop; },
        set(val) { backingScrollTop = Number(val); },
    });
    const origDefineProperty = Object.defineProperty;
    Object.defineProperty = function (target, prop, desc) {
        if (target === proto && prop === 'scrollTop') defineCount += 1;
        return origDefineProperty.call(Object, target, prop, desc);
    };
    try {
        let blockMobile = true;
        let deferredVal = null;
        scrollTopPatch.registerScrollTopWriteInterceptor('mobile', () => blockMobile, { prototype: proto, priority: 10 });
        scrollTopPatch.registerScrollTopWriteInterceptor('theme', (_el, val) => {
            deferredVal = val;
            return true;
        }, { prototype: proto, priority: 20 });
        assert.equal(defineCount, 1, 'scrollTop descriptor must be patched strictly once');

        const elem = Object.create(proto);
        elem.scrollTop = 120;
        assert.equal(backingScrollTop, 0, 'Higher-priority mobile guard blocks write');
        assert.equal(deferredVal, null, 'Blocked write must not fall through to theme deferral');

        blockMobile = false;
        elem.scrollTop = 240;
        assert.equal(deferredVal, 240, 'Unblocked write reaches theme deferral');
    } finally {
        Object.defineProperty = origDefineProperty;
    }

    // 2. Fast Chat progressive loading is a pure no-op.
    const fastChat = await import('../src/features/fastChat.js');
    const sentinelFetch = () => {};
    const prevFetch = globalThis.fetch;
    globalThis.fetch = sentinelFetch;
    try {
        fastChat.applyFastChatGetOptimization();
        assert.equal(globalThis.fetch, sentinelFetch);
    } finally {
        globalThis.fetch = prevFetch;
    }

    // 3. streamingRegexDefer skips updateMessageBlock when processor.previewFailed === true.
    const listeners = new Map();
    let renderCalls = 0;
    const chatArr = [{ name: 'Alice', mes: '```panel\nhi\n```' }];
    const processor = { messageId: 0, isFinished: false, isStopped: false, previewFailed: false };
    const context = vm.createContext({ console });
    const deferMod = await loadVmModule('../src/chat/streamingRegexDefer.js', context, {
        '@sillytavern/script': {
            chat: chatArr,
            event_types: { GENERATION_ENDED: 'GENERATION_ENDED', CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED', CHAT_CHANGED: 'CHAT_CHANGED' },
            eventSource: {
                makeFirst(ev, fn) { listeners.set(ev, fn); },
                on(ev, fn) { listeners.set(ev, fn); },
            },
            streamingProcessor: processor,
            updateMessageBlock: () => { renderCalls += 1; },
        },
        '@sillytavern/scripts/extensions/regex/engine': {
            getRegexedString: () => '',
            regex_placement: { AI_OUTPUT: 2 },
        },
        './constants.js': chatConstants,
        './state.js': { LOG_PREFIX: '[test]', extensionState: {}, settings: { streamingRegexDeferEnabled: true } },
    });
    deferMod.applyStreamingRegexDefer();
    const skipped = context[chatConstants.STREAMING_REGEX_DEFER_BRIDGE_KEY].beforeScript(
        { replaceString: '```html\n$1\n```', disabled: false },
        'raw chunk',
        { isMarkdown: true, depth: 0, placement: 2, characterOverride: 'Alice' },
    );
    assert.equal(skipped, 'raw chunk');

    // When previewFailed === true, flush must NOT call updateMessageBlock.
    processor.isStopped = true;
    processor.previewFailed = true;
    listeners.get('CHARACTER_MESSAGE_RENDERED')();
    assert.equal(renderCalls, 0);

    // Normal stream error (isStopped=true, previewFailed=false) still flushes once.
    processor.isStopped = false;
    processor.previewFailed = false;
    context[chatConstants.STREAMING_REGEX_DEFER_BRIDGE_KEY].beforeScript(
        { replaceString: '```html\n$1\n```', disabled: false },
        'raw chunk 2',
        { isMarkdown: true, depth: 0, placement: 2, characterOverride: 'Alice' },
    );
    processor.isStopped = true;
    listeners.get('CHARACTER_MESSAGE_RENDERED')();
    assert.equal(renderCalls, 1);
});

test('FX-T1, FX-T2 & FX-T3: rAF post-append refresh token guard, coalesced globalSelector display refresh, and full-snapshot dropdown theme signature', async () => {
    class MockNode {}
    class MockElement extends MockNode {
        constructor(tag = 'div') {
            super();
            this.tagName = tag.toUpperCase();
            this.dataset = {};
            this.style = {};
            this.children = [];
            this.isConnected = true;
            this.classList = {
                add() {},
                remove() {},
                toggle() {},
                contains: () => false,
            };
        }
        append(...items) { this.children.push(...items); }
        setAttribute() {}
        removeAttribute() {}
        addEventListener() {}
        removeEventListener() {}
        closest() { return null; }
        querySelector() { return null; }
        querySelectorAll() { return []; }
    }
    class MockHTMLElement extends MockElement {}
    class MockHTMLSelectElement extends MockHTMLElement {}
    class MockHTMLInputElement extends MockHTMLElement {}
    class MockHTMLTextAreaElement extends MockHTMLElement {}

    // --- FX-T1: mountWorldInfoVueListApp yields one frame and skips stale renderToken ---
    let nextRafId = 1;
    const rafCallbacks = new Map();
    let refreshPanelCalls = 0;
    const listEl = Object.assign(new MockHTMLElement('div'), { id: 'world_popup_entries_list' });
    const t1Context = vm.createContext({
        console,
        Set,
        Map,
        Node: MockNode,
        Element: MockElement,
        HTMLElement: MockHTMLElement,
        HTMLTextAreaElement: MockHTMLTextAreaElement,
        CSS: { supports: () => true },
        document: {
            getElementById: id => (id === 'world_popup_entries_list' ? listEl : null),
            createElement: tag => new MockHTMLElement(tag),
        },
        requestAnimationFrame: fn => {
            const id = nextRafId++;
            rafCallbacks.set(id, fn);
            return id;
        },
        cancelAnimationFrame: id => {
            rafCallbacks.delete(id);
        },
    });
    const vueList = await loadVmModule('../src/worldinfo/vueList.js', t1Context, {
        '@sillytavern/scripts/utils': { resetScrollHeight: async () => {} },
        './constants.js': worldInfoConstants,
        './editorSelect.js': {},
        './globalSelector.js': {},
        './mobileLayout.js': { shouldUseWorldInfoMobileHeaderLayout: () => false, removeWorldInfoMobileLayoutMutationObserver: () => {} },
        './mobileLayoutStyle.js': {},
        './searchReplace.js': {
            installWorldInfoSearchReplacePanel: () => { refreshPanelCalls += 1; },
            removeWorldInfoSearchReplacePanel: () => {},
        },
        './state.js': {
            LOG_PREFIX: '[test]',
            extensionState: {},
            settings: { worldInfoListOptimizationEnabled: true, worldInfoSearchReplaceEnabled: true },
        },
    });

    const wiState = vueList.getWorldInfoVueListOptimizationState();
    const entryA = new MockHTMLElement('div');
    const entryB = new MockHTMLElement('div');
    wiState.renderToken = 1;
    vueList.mountWorldInfoVueListApp(wiState, listEl, [[entryA]], null, 1);
    assert.equal(refreshPanelCalls, 0, 'Post-append refresh must wait for rAF');
    assert.equal(rafCallbacks.size, 1);

    // Supersede render #1 with render #2 before the frame fires.
    const firstFrameFn = [...rafCallbacks.values()][0];
    wiState.renderToken = 2;
    vueList.mountWorldInfoVueListApp(wiState, listEl, [[entryB]], null, 2);
    assert.equal(rafCallbacks.size, 1, 'Previous pending refresh frame should be canceled');
    // Even if an already-dispatched stale callback runs, renderToken mismatch must skip refresh.
    firstFrameFn();
    assert.equal(refreshPanelCalls, 0, 'Stale renderToken must skip refreshWorldInfoVueListAfterAppend');

    // Latest render #2 completes normally on frame flush.
    const secondFrameFn = [...rafCallbacks.values()][0];
    rafCallbacks.clear();
    secondFrameFn();
    assert.equal(refreshPanelCalls, 1, 'Latest renderToken must execute refreshWorldInfoVueListAfterAppend');

    // --- FX-T2: #world_editor_select change coalesces in rAF and refreshes only display ---
    const docListeners = new Map();
    const t2RafQueue = [];
    let displayClearCount = 0;
    let dropdownClearCount = 0;
    const t2Context = vm.createContext({
        console,
        Set,
        Map,
        Node: MockNode,
        Element: MockElement,
        HTMLElement: MockHTMLElement,
        HTMLSelectElement: MockHTMLSelectElement,
        document: {
            body: new MockHTMLElement('body'),
            addEventListener(type, fn) { docListeners.set(type, fn); },
            removeEventListener(type) { docListeners.delete(type); },
            createElement(tag) {
                const el = new MockHTMLElement(tag);
                let text = '';
                Object.defineProperty(el, 'textContent', {
                    configurable: true,
                    get() { return text; },
                    set(val) { text = String(val); },
                });
                return el;
            },
        },
        requestAnimationFrame: fn => {
            t2RafQueue.push(fn);
            return t2RafQueue.length;
        },
        cancelAnimationFrame: () => {
            t2RafQueue.length = 0;
        },
    });
    const globalSelector = await loadVmModule('../src/worldinfo/globalSelector.js', t2Context, {
        '@sillytavern/script': { event_types: { WORLDINFO_SETTINGS_UPDATED: 'WI_UPDATED' }, eventSource: { on() {}, removeListener() {} } },
        '@sillytavern/scripts/RossAscends-mods': { isMobile: () => false },
        '@sillytavern/scripts/world-info': { selected_world_info: ['OldBook'] },
        './constants.js': worldInfoConstants,
        './editorSelect.js': {
            getWorldInfoOptionName: opt => String(opt?.textContent ?? '').trim(),
            normalizeWorldInfoNameList: list => (Array.isArray(list) ? list : []),
        },
        './state.js': { LOG_PREFIX: '[test]', settings: { worldInfoListOptimizationEnabled: true } },
        './vueList.js': { getWorldInfoVueListOptimizationState: () => wiState },
    });

    const displayEl = new MockHTMLElement('div');
    Object.defineProperty(displayEl, 'textContent', {
        configurable: true,
        get() { return ''; },
        set(val) {
            if (val === '') {
                this.children = [];
                displayClearCount += 1;
            }
        },
    });
    const renamedOption = { value: '0', textContent: 'OldBook', selected: true, dataset: { [worldInfoConstants.WORLD_INFO_GLOBAL_SELECTOR_OPTION_ORDER_DATASET_KEY]: '0' } };
    const unindexedOption = { value: '1', textContent: 'OtherBook', selected: false, dataset: {} };
    const globalSelect = Object.assign(new MockHTMLSelectElement('select'), {
        multiple: true,
        options: [renamedOption, unindexedOption],
        get selectedOptions() { return this.options.filter(o => o.selected); },
    });
    globalSelect[worldInfoConstants.WORLD_INFO_GLOBAL_SELECTOR_STATE_KEY] = { displayEl };
    const openOptionsContainer = new MockHTMLElement('div');
    Object.defineProperty(openOptionsContainer, 'textContent', {
        configurable: true,
        get() { return ''; },
        set() { dropdownClearCount += 1; },
    });
    wiState.worldInfoGlobalSelectorSelects = new Set([globalSelect]);
    wiState.worldInfoGlobalSelectorDropdown = {
        select: globalSelect,
        displayEl,
        optionsContainer: openOptionsContainer,
        orderedOptions: [renamedOption, unindexedOption],
        searchInput: { value: '' },
    };

    globalSelector.installWorldInfoGlobalSelectorSyncHandler(wiState);
    renamedOption.textContent = 'RenamedBook';
    const editorSelect = Object.assign(new MockHTMLSelectElement('select'), { id: 'world_editor_select' });
    const changeHandler = docListeners.get('change');
    changeHandler({ target: editorSelect });
    changeHandler({ target: editorSelect });
    changeHandler({ target: editorSelect });

    assert.equal(t2RafQueue.length, 1, 'Multiple #world_editor_select changes in one frame must coalesce into one rAF');
    assert.equal(displayClearCount, 0, 'Display refresh must be deferred until the animation frame');
    const flushT2 = t2RafQueue.shift();
    flushT2();
    assert.equal(displayClearCount, 1, 'Display must refresh strictly once for coalesced changes');
    assert.equal(displayEl.children[0]?.children?.[0]?.textContent, 'RenamedBook', 'Chip label must reflect renamed worldbook');
    assert.equal(dropdownClearCount, 0, 'Dropdown options must not be rebuilt on #world_editor_select change');
    assert.equal(
        unindexedOption.dataset[worldInfoConstants.WORLD_INFO_GLOBAL_SELECTOR_OPTION_ORDER_DATASET_KEY],
        undefined,
        'Option ordering must not run on #world_editor_select change',
    );
    globalSelector.removeWorldInfoGlobalSelectorSyncHandler(wiState);

    // --- FX-T3: Dropdown theme signature includes all snapshot properties (e.g. border radius) ---
    const t3Context = vm.createContext({
        console,
        Set,
        Map,
        Element: MockElement,
        HTMLElement: MockHTMLElement,
        HTMLSelectElement: MockHTMLSelectElement,
        HTMLInputElement: MockHTMLInputElement,
        document: { querySelector: () => null, getElementById: () => null },
    });
    const editorSelectMod = await loadVmModule('../src/worldinfo/editorSelect.js', t3Context, {
        '@sillytavern/script': { characters: [], chat_metadata: {}, this_chid: undefined },
        '@sillytavern/scripts/RossAscends-mods': { isMobile: () => false },
        '@sillytavern/scripts/utils': { getCharaFilename: () => '' },
        '@sillytavern/scripts/world-info': { METADATA_KEY: 'world_info', selected_world_info: [], world_info: {}, world_names: [] },
        './constants.js': worldInfoConstants,
        './state.js': { LOG_PREFIX: '[test]' },
        './vueList.js': { getWorldInfoVueListOptimizationState: () => wiState },
    });

    const searchField = new MockHTMLInputElement('input');
    const baseStyle = {
        backgroundColor: 'rgb(20, 20, 20)',
        borderTopColor: 'rgb(80, 80, 80)',
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomLeftRadius: '4px',
        borderBottomRightRadius: '4px',
        color: 'rgb(240, 240, 240)',
        fontSize: '14px',
        height: '32px',
    };
    editorSelectMod.syncWorldInfoEditorSelectDropdownTheme(editorSelect, searchField, baseStyle);
    assert.equal(searchField.style.borderTopLeftRadius, '4px');

    editorSelectMod.syncWorldInfoEditorSelectDropdownTheme(editorSelect, searchField, {
        ...baseStyle,
        borderTopLeftRadius: '14px',
        borderBottomRightRadius: '14px',
    });
    assert.equal(searchField.style.borderTopLeftRadius, '14px', 'Radius-only theme change must re-apply dropdown styles');
    assert.equal(searchField.style.borderBottomRightRadius, '14px');
});

test('FX-T4, FX-T5 & FX-T7: shared GENERATION_REQUEST_ID_KEY, extensionOps 60s transient cooldown, and scrollTop fallback without rAF', async () => {
    // --- FX-T4: single constant source for generation request marker ---
    assert.equal(generateRequest.GENERATION_REQUEST_ID_KEY, '__baibai_generation_id');
    const retrySource = await readFile(new URL('../src/features/generateRetry.js', import.meta.url), 'utf8');
    assert.equal(retrySource.includes('GENERATION_REQUEST_ID_KEY'), true);
    assert.equal(retrySource.includes("'__baibai_generation_id'"), false);

    // --- FX-T5: 60s cooldown on transient manager/config error, cleared after expiry or reset ---
    let fakeNow = 1_000_000;
    let configFetchCount = 0;
    let failConfigFetch = true;
    const storage = new Map([['bai_bai_toolkit_extension_install_optimization_enabled', 'true']]);
    const t5StateHolder = { extensionOps: null };
    const t5Context = vm.createContext({
        URL,
        Headers,
        Request,
        Response,
        AbortController,
        crypto,
        console,
        setTimeout,
        clearTimeout,
        Date: { now: () => fakeNow },
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, val) => storage.set(key, String(val)),
        },
        sessionStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        },
        fetch: async (input) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.endsWith('/manager/config')) {
                configFetchCount += 1;
                if (failConfigFetch) {
                    return new Response(JSON.stringify({ ok: false, error: { message: 'Temporary error' } }), { status: 503 });
                }
                return new Response(JSON.stringify({ ok: true, data: { interceptEnabled: true } }), { status: 200 });
            }
            // Native response without X-Baibaoku-Extension-Op header
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
    });
    const extensionOps = await loadVmModule('../src/features/extensionOps.js', t5Context, {
        '@sillytavern/script': { event_types: { APP_READY: 'APP_READY' }, eventSource: { once() {} }, getRequestHeaders: () => ({}) },
        '@sillytavern/scripts/popup': { callGenericPopup: async () => 0, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1, TEXT: 2 } },
        './constants.js': featureConstants,
        './gzipHook.js': gzipHook,
        './state.js': { extensionState: t5StateHolder },
        './updateDiagnostics.js': { hasUserInteracted: () => false },
        './util.js': featureUtil,
    });

    assert.equal(await extensionOps.ensureExtensionInterceptEnabled(), true, 'Falls back to localStorage value on transient error');
    assert.equal(configFetchCount, 1);

    fakeNow += 15_000;
    assert.equal(await extensionOps.ensureExtensionInterceptEnabled(), true);
    assert.equal(configFetchCount, 1, 'Must not re-fetch manager/config within 60s cooldown');

    fakeNow += 50_000;
    failConfigFetch = false;
    assert.equal(await extensionOps.ensureExtensionInterceptEnabled(), true);
    assert.equal(configFetchCount, 2, 'Must resume manager/config check after 60s cooldown expires');

    // Triggering an operation whose response lacks X-Baibaoku-Extension-Op clears state + cooldown.
    extensionOps.installExtensionOpsFetchHook();
    t5StateHolder.extensionOps.interceptRetryAfter = fakeNow + 30_000;
    await t5Context.fetch('/api/extensions/update', {
        method: 'POST',
        body: JSON.stringify({ extensionName: 'third-party/ST-BaiBai-Tools', global: false }),
    });
    assert.equal(t5StateHolder.extensionOps.interceptRetryAfter, 0, 'Missing op header reset must clear cooldown');

    // --- FX-T7: scrollTop write falls through directly when requestAnimationFrame is unavailable ---
    class MockHTMLElementNoRaf {}
    let backingScrollTop = 0;
    Object.defineProperty(MockHTMLElementNoRaf.prototype, 'scrollTop', {
        configurable: true,
        get() { return backingScrollTop; },
        set(val) { backingScrollTop = Number(val); },
    });
    const t7Context = vm.createContext({
        console,
        Map,
        Set,
        Date,
        HTMLElement: MockHTMLElementNoRaf,
        requestAnimationFrame: undefined,
    });
    const themeMod = await loadVmModule('../src/features/theme.js', t7Context, {
        '@sillytavern/script': { getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} },
        '@sillytavern/scripts/power-user': { applyPowerUserSettings: () => {}, power_user: {} },
        '@sillytavern/scripts/utils': { cancelDebounce: () => {} },
        '../scrollTopPatch.js': scrollTopPatch,
        './constants.js': {
            ...featureConstants,
            BAIBAOKU_THEME_COLOR_BINDINGS: [],
            BAIBAOKU_THEME_POWER_USER_KEYS: [],
            CUSTOM_CSS_THEME_SYNC_SETTLE_DELAYS_MS: [80],
            THEME_APPLY_REFLOW_GUARD_METRICS: ['scrollHeight'],
            THEME_APPLY_REFLOW_GUARD_PATCH_KEY: '__testThemeReflowGuard',
            THEME_APPLY_REFLOW_GUARD_WINDOW_MS: 1500,
        },
        './customCss.js': { syncCustomCssStateFromSettings: () => {} },
        './gzipHook.js': gzipHook,
        './state.js': { extensionState: {}, settings: {} },
    });

    themeMod.installThemeApplyScrollTopWriteDeferral(
        { windowUntil: Date.now() + 5000, scrollTopFlushFrame: 0, pendingScrollTop: null },
        MockHTMLElementNoRaf.prototype,
    );
    const chatEl = Object.assign(new MockHTMLElementNoRaf(), { id: 'chat' });
    chatEl.scrollTop = 420;
    assert.equal(backingScrollTop, 420, 'Without requestAnimationFrame, scrollTop write must execute directly');
});

test('FX2-2 & FX2-3: legacy <GROUP>/<CHARIFNOTGROUP> macro gating and scrollTop interceptor failure isolation', async () => {
    // --- FX2-2: legacy <GROUP> and <CHARIFNOTGROUP> macros stop WI prewarm and skip bulk prompt collection ---
    const tokContext = vm.createContext({
        URL,
        Headers,
        Map,
        Set,
        console,
        location: new URL('http://localhost:8000/'),
        fetch: async () => new Response(JSON.stringify({ ok: true, data: { counts: [] } }), { status: 200 }),
    });
    const tokenizer = await loadVmModule('../src/preset/tokenizer.js', tokContext, {
        '@sillytavern/script': {
            main_api: 'openai',
            getRequestHeaders: () => ({}),
            getCurrentChatId: () => 'chat-1',
        },
        '@sillytavern/scripts/openai': { oai_settings: {}, promptManager: {} },
        '@sillytavern/scripts/tokenizers': { getTokenizerModel: () => 'gpt-4o' },
        '@sillytavern/scripts/utils': { getStringHash: text => String(text).length },
        './constants.js': presetConstants,
        './saveToggle.js': { updatePromptTokenCell() {} },
        './state.js': { LOG_PREFIX: '[test]', extensionState: {}, settings: { tokenizerBulkCountEnabled: true } },
        './switchFast.js': {},
        './util.js': { isPresetGenerationActive: () => false },
        './vueList.js': { isPresetVuePromptListDragging: () => false },
        './vueModel.js': {},
    });

    const wiCollected = tokenizer.collectOpenAITokenizerWorldInfoBudgetMessages({
        textToScan: '',
        entries: [
            { content: 'plain before group', maySkip: false },
            { content: 'Active party: <GROUP>', maySkip: false },
            { content: 'plain after group', maySkip: false },
        ],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(wiCollected)), [{ role: 'system', content: 'plain before group\n' }]);

    const bulkCollected = await tokenizer.collectOpenAITokenizerBulkMessages({
        newChatContent: '[Start chat with <CHARIFNOTGROUP>]',
        sendIfEmpty: 'Plain fallback prompt',
        newExampleChatContent: '[Example for <group>]',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(bulkCollected)), [{ role: 'user', content: 'Plain fallback prompt' }]);

    // --- FX2-3: throwing scrollTop interceptor is isolated without breaking lower-priority interceptors or native setter ---
    let backingScrollTop = 0;
    const proto = {};
    Object.defineProperty(proto, 'scrollTop', {
        configurable: true,
        get() { return backingScrollTop; },
        set(val) { backingScrollTop = Number(val); },
    });

    let lowerPriorityCalls = 0;
    let interceptInLower = false;
    let interceptedValue = null;

    scrollTopPatch.registerScrollTopWriteInterceptor(
        'throwingGuard',
        () => {
            throw new Error('simulated interceptor failure');
        },
        { prototype: proto, priority: 5 },
    );
    scrollTopPatch.registerScrollTopWriteInterceptor(
        'workingGuard',
        (_el, val) => {
            lowerPriorityCalls += 1;
            if (!interceptInLower) return false;
            interceptedValue = val;
            return true;
        },
        { prototype: proto, priority: 10 },
    );

    const elem = Object.create(proto);
    const debugCalls = [];
    const origDebug = console.debug;
    console.debug = (...args) => { debugCalls.push(args); };
    try {
        assert.doesNotThrow(() => {
            elem.scrollTop = 180;
        });
        assert.equal(lowerPriorityCalls, 1, 'Lower-priority interceptor must still run after higher-priority failure');
        assert.equal(backingScrollTop, 180, 'Original setter must still run when remaining interceptors return false');

        interceptInLower = true;
        elem.scrollTop = 360;
        assert.equal(lowerPriorityCalls, 2);
        assert.equal(interceptedValue, 360);
        assert.equal(backingScrollTop, 180, 'Working lower-priority interceptor can still intercept write');
        assert.equal(debugCalls.length, 2);
        assert.equal(String(debugCalls[0][0]).includes('"throwingGuard"'), true);
    } finally {
        console.debug = origDebug;
    }
});
