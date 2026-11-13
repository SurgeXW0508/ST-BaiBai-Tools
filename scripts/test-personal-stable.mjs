import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import * as chatConstants from '../src/chat/constants.js';
import * as generateRequest from '../src/features/generateRequest.js';
import * as scrollTopPatch from '../src/scrollTopPatch.js';

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
