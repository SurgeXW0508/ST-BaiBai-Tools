import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { parse } from 'espree';
import * as chatConstants from '../src/chat/constants.js';
import * as generateRequest from '../src/features/generateRequest.js';
import * as scrollTopPatch from '../src/scrollTopPatch.js';
import * as worldInfoConstants from '../src/worldinfo/constants.js';
import { resolveRuntimeSillyTavernRelativePath, resolveSillyTavernImportSpecifier } from '../vite.config.mjs';

const execFileAsync = promisify(execFileCb);

const featureConstants = {
    CURRENT_VERSION: '1.2.0',
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

const fetchPipelineModuleCache = new WeakMap();

async function getFetchPipelineVmModule(context) {
    let cached = fetchPipelineModuleCache.get(context);
    if (!cached) {
        cached = (async () => {
            const pipelineUrl = new URL('../src/features/fetchPipeline.js', import.meta.url);
            const pipelineCode = await readFile(pipelineUrl, 'utf8');
            const pipelineMod = new vm.SourceTextModule(pipelineCode, {
                context,
                identifier: '../src/features/fetchPipeline.js',
            });
            await pipelineMod.link(specifier => {
                throw new Error(`Unexpected import in fetchPipeline.js: ${specifier}`);
            });
            await pipelineMod.evaluate();
            return pipelineMod;
        })();
        fetchPipelineModuleCache.set(context, cached);
    }
    return cached;
}

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
    await mod.link(async source => {
        if (!dependencies.has(source)) {
            if (!(source in mocks) && (source === './fetchPipeline.js' || source.endsWith('/fetchPipeline.js'))) {
                dependencies.set(source, await getFetchPipelineVmModule(context));
                return dependencies.get(source);
            }
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

function collectModuleExportNames(filePath, seen = new Set()) {
    if (seen.has(filePath)) return new Set();
    seen.add(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const exported = new Set();
    for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                const decl = node.declaration;
                if (decl.id?.name) exported.add(decl.id.name);
                if (Array.isArray(decl.declarations)) {
                    for (const item of decl.declarations) {
                        if (item.id?.type === 'Identifier') {
                            exported.add(item.id.name);
                        } else if (item.id?.type === 'ObjectPattern') {
                            for (const prop of item.id.properties || []) {
                                if (prop.value?.type === 'Identifier') exported.add(prop.value.name);
                            }
                        }
                    }
                }
            }
            for (const spec of node.specifiers || []) {
                const name = spec.exported?.name || spec.exported?.value;
                if (name) exported.add(name);
            }
        } else if (node.type === 'ExportDefaultDeclaration') {
            exported.add('default');
        } else if (node.type === 'ExportAllDeclaration' && typeof node.source?.value === 'string') {
            const targetPath = path.resolve(path.dirname(filePath), node.source.value);
            if (fs.existsSync(targetPath)) {
                for (const name of collectModuleExportNames(targetPath, seen)) {
                    exported.add(name);
                }
            }
        }
    }
    return exported;
}

const EXPECTED_STATIC_HOST_MODULES = [
    'script.js',
    'scripts/PromptManager.js',
    'scripts/RossAscends-mods.js',
    'scripts/autocomplete/AutoComplete.js',
    'scripts/extensions.js',
    'scripts/extensions/regex/engine.js',
    'scripts/group-chats.js',
    'scripts/i18n.js',
    'scripts/openai.js',
    'scripts/popup.js',
    'scripts/power-user.js',
    'scripts/preset-manager.js',
    'scripts/templates.js',
    'scripts/tokenizers.js',
    'scripts/user.js',
    'scripts/utils.js',
    'scripts/world-info.js',
];

const EXPECTED_DYNAMIC_HOST_IMPORTS = new Map([
    ['/scripts/world-info.js', ['checkWorldInfo']],
]);

function collectDynamicImports(rootNode) {
    const literals = new Set();
    const nonLiterals = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ImportExpression') {
            const src = node.source;
            if (src?.type === 'Literal' && typeof src.value === 'string') {
                literals.add(src.value);
            } else {
                nonLiterals.push(src?.type ?? 'unknown');
            }
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value) visit(item);
            } else if (value && typeof value.type === 'string') {
                visit(value);
            }
        }
    };
    visit(rootNode);
    return { literals: [...literals].sort(), nonLiterals };
}

test('FX3-1: manifest.json entry (dist/index.js + dist/index.css) resolves all static & dynamic ST host imports independent of checkout path', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // 1. Unit-verify runtime URL relative resolver and @sillytavern/* mapper
    assert.equal(resolveRuntimeSillyTavernRelativePath('dist/index.js?ver=1.2.0'), '../../../../..');
    assert.equal(resolveRuntimeSillyTavernRelativePath('dist/index.js'), '../../../../..');
    assert.equal(resolveRuntimeSillyTavernRelativePath('index.js?ver=1.0.0'), '../../../..');
    assert.equal(resolveRuntimeSillyTavernRelativePath('dist\\nested\\entry.js#frag'), '../../../../../..');
    assert.throws(() => resolveRuntimeSillyTavernRelativePath(''), /Invalid manifest\.json "js" entry path/);
    assert.throws(() => resolveRuntimeSillyTavernRelativePath('../escape.js'), /Invalid manifest\.json "js" entry path/);
    assert.throws(() => resolveRuntimeSillyTavernRelativePath('dist/../../escape.js'), /Invalid manifest\.json "js" entry path/);

    assert.equal(resolveSillyTavernImportSpecifier('@sillytavern/script', '../../../../..'), '../../../../../script.js');
    assert.equal(
        resolveSillyTavernImportSpecifier('@sillytavern/scripts/extensions/regex/engine.js', '../../../../..'),
        '../../../../../scripts/extensions/regex/engine.js',
    );
    assert.equal(resolveSillyTavernImportSpecifier('vue', '../../../../..'), null);
    assert.throws(() => resolveSillyTavernImportSpecifier('@sillytavern/', '../../../../..'), /Invalid @sillytavern import specifier/);
    assert.throws(() => resolveSillyTavernImportSpecifier('@sillytavern/../secret', '../../../../..'), /Invalid @sillytavern import specifier/);

    // 2. Verify the real delivered artifacts referenced by manifest.json and Pen Shadow DOM
    const manifestJson = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
    const entryRelPath = path.posix.normalize(String(manifestJson.js ?? '').split(/[?#]/, 1)[0].replaceAll('\\', '/'));
    assert.equal(entryRelPath, 'dist/index.js');

    const distEntryPath = path.join(repoRoot, entryRelPath);
    const distCssPath = path.join(repoRoot, 'dist', 'index.css');
    const [distCode, distCss] = await Promise.all([
        readFile(distEntryPath, 'utf8'),
        readFile(distCssPath, 'utf8'),
    ]);
    assert.ok(distCode.length > 0, 'Committed dist/index.js must not be empty');
    assert.ok(distCss.length > 0, 'Committed dist/index.css must not be empty');
    assert.equal(distCode.includes('@sillytavern/'), false, 'Committed dist/index.js must not retain bare @sillytavern/ specifiers');

    const ast = parse(distCode, { ecmaVersion: 'latest', sourceType: 'module' });
    const importDecls = ast.body.filter(node => node.type === 'ImportDeclaration');

    const sentinelPublicRoot = '/__st_public__';
    const sentinelExtRoot = `${sentinelPublicRoot}/scripts/extensions/third-party/ST-BaiBai-Tools`;
    const sentinelEntryPath = path.posix.join(sentinelExtRoot, entryRelPath);
    const sentinelEntryDir = path.posix.dirname(sentinelEntryPath);

    const resolvedHostModules = new Map();
    for (const decl of importDecls) {
        const spec = String(decl.source?.value ?? '');
        assert.equal(spec.startsWith('@sillytavern/'), false, `Unresolved @sillytavern specifier: ${spec}`);
        assert.equal(spec.startsWith('../'), true, `Expected relative import in bundled dist/index.js, got: ${spec}`);

        const resolvedPosix = path.posix.resolve(sentinelEntryDir, spec);
        assert.equal(
            resolvedPosix.startsWith(`${sentinelPublicRoot}/`),
            true,
            `Import "${spec}" escaped above SillyTavern public/ root: ${resolvedPosix}`,
        );
        assert.notEqual(
            resolvedPosix,
            `${sentinelPublicRoot}/scripts/script.js`,
            `Import "${spec}" resolved to broken /scripts/script.js (missing ../ depth)`,
        );

        if (resolvedPosix.startsWith(`${sentinelExtRoot}/`)) {
            const extLocalRel = path.posix.relative(sentinelExtRoot, resolvedPosix);
            assert.equal(fs.existsSync(path.join(repoRoot, extLocalRel)), true, `Missing extension-local import: ${extLocalRel}`);
        } else {
            const hostRelPath = path.posix.relative(sentinelPublicRoot, resolvedPosix);
            const wantedNames = resolvedHostModules.get(hostRelPath) ?? new Set();
            for (const item of decl.specifiers || []) {
                if (item.type === 'ImportDefaultSpecifier') {
                    wantedNames.add('default');
                } else if (item.type === 'ImportSpecifier') {
                    wantedNames.add(item.imported.name || item.imported.value);
                }
            }
            resolvedHostModules.set(hostRelPath, wantedNames);
        }
    }

    assert.deepEqual(
        [...resolvedHostModules.keys()].sort(),
        EXPECTED_STATIC_HOST_MODULES,
        'Static SillyTavern host module set changed; review new/removed host contract and update EXPECTED_STATIC_HOST_MODULES',
    );

    // 2b. Verify dynamic imports in bundled dist/index.js (e.g. import('/scripts/world-info.js'))
    const dynamicImports = collectDynamicImports(ast);
    assert.deepEqual(
        dynamicImports.nonLiterals,
        [],
        `Unexpected non-literal dynamic import() in dist/index.js: ${dynamicImports.nonLiterals.join(', ')}`,
    );
    assert.deepEqual(
        dynamicImports.literals,
        [...EXPECTED_DYNAMIC_HOST_IMPORTS.keys()].sort(),
        'Dynamic host import() set changed; review runtime URL resolution and update EXPECTED_DYNAMIC_HOST_IMPORTS',
    );

    // 3. Link dist/index.js as a real ES module in node:vm to verify static module bindings
    const linkContext = vm.createContext({ URL, console });
    const syntheticDeps = new Map();
    const distVmModule = new vm.SourceTextModule(distCode, {
        context: linkContext,
        identifier: 'https://sillytavern.local/scripts/extensions/third-party/ST-BaiBai-Tools/dist/index.js',
    });
    await distVmModule.link(specifier => {
        if (!syntheticDeps.has(specifier)) {
            const names = new Set();
            for (const decl of importDecls.filter(item => item.source.value === specifier)) {
                for (const spec of decl.specifiers || []) {
                    if (spec.type === 'ImportDefaultSpecifier') names.add('default');
                    if (spec.type === 'ImportSpecifier') names.add(spec.imported.name || spec.imported.value);
                }
            }
            syntheticDeps.set(specifier, new vm.SyntheticModule([...names], function () {
                for (const name of names) this.setExport(name, () => {});
            }, { context: linkContext }));
        }
        return syntheticDeps.get(specifier);
    });

    // 4. When SillyTavern public/ is present alongside this checkout, verify all static & dynamic host files and symbols exist
    const candidateStPublic = process.env.SILLYTAVERN_PUBLIC_DIR
        || path.resolve(repoRoot, '..', 'SillyTavern', 'public');
    if (fs.existsSync(path.join(candidateStPublic, 'script.js'))) {
        for (const [hostRelPath, wantedSymbols] of resolvedHostModules.entries()) {
            const diskPath = path.join(candidateStPublic, hostRelPath);
            assert.equal(fs.existsSync(diskPath), true, `Host module missing in SillyTavern/public: ${hostRelPath}`);
            const actualExports = collectModuleExportNames(diskPath);
            for (const sym of wantedSymbols) {
                assert.equal(
                    actualExports.has(sym),
                    true,
                    `Host module ${hostRelPath} does not export imported symbol "${sym}"`,
                );
            }
        }
        for (const [dynPath, wantedSymbols] of EXPECTED_DYNAMIC_HOST_IMPORTS.entries()) {
            const relFromPublic = dynPath.replace(/^\/+/, '');
            const diskPath = path.join(candidateStPublic, relFromPublic);
            assert.equal(fs.existsSync(diskPath), true, `Dynamic host module missing in SillyTavern/public: ${dynPath}`);
            const actualExports = collectModuleExportNames(diskPath);
            for (const sym of wantedSymbols) {
                assert.equal(
                    actualExports.has(sym),
                    true,
                    `Dynamic host module ${dynPath} does not export expected symbol "${sym}"`,
                );
            }
        }
    }

    // 5. Prove Vite build output (JS + CSS) is deterministic and identical regardless of checkout path depth or ancestor "public" segment
    const viteCliPath = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'bbt-vite-layout-'));
    try {
        const layouts = [
            path.join(tmpBase, 'flat-checkout'),
            path.join(tmpBase, 'nested', 'public', 'trap', 'deeper', 'ST-BaiBai-Tools'),
        ];
        for (let i = 0; i < layouts.length; i += 1) {
            const workDir = layouts[i];
            await mkdir(workDir, { recursive: true });
            await Promise.all([
                copyFile(path.join(repoRoot, 'vite.config.mjs'), path.join(workDir, 'vite.config.mjs')),
                copyFile(path.join(repoRoot, 'tsconfig.json'), path.join(workDir, 'tsconfig.json')),
                copyFile(path.join(repoRoot, 'package.json'), path.join(workDir, 'package.json')),
                copyFile(path.join(repoRoot, 'manifest.json'), path.join(workDir, 'manifest.json')),
                cp(path.join(repoRoot, 'src'), path.join(workDir, 'src'), { recursive: true }),
                symlink(path.join(repoRoot, 'node_modules'), path.join(workDir, 'node_modules'), 'dir'),
            ]);
            await execFileAsync(
                process.execPath,
                [viteCliPath, 'build', '--mode', 'production', '--logLevel', 'silent'],
                { cwd: workDir },
            );
            const [rebuiltCode, rebuiltCss] = await Promise.all([
                readFile(path.join(workDir, 'dist', 'index.js'), 'utf8'),
                readFile(path.join(workDir, 'dist', 'index.css'), 'utf8'),
            ]);
            assert.equal(
                rebuiltCode === distCode,
                true,
                `Build output dist/index.js in ${workDir} must match committed dist/index.js byte-for-byte`,
            );
            assert.equal(
                rebuiltCss === distCss,
                true,
                `Build output dist/index.css in ${workDir} must match committed dist/index.css byte-for-byte`,
            );

            // Determinism check on first layout: consecutive build produces identical JS + CSS
            if (i === 0) {
                await execFileAsync(
                    process.execPath,
                    [viteCliPath, 'build', '--mode', 'production', '--logLevel', 'silent'],
                    { cwd: workDir },
                );
                const [secondCode, secondCss] = await Promise.all([
                    readFile(path.join(workDir, 'dist', 'index.js'), 'utf8'),
                    readFile(path.join(workDir, 'dist', 'index.css'), 'utf8'),
                ]);
                assert.equal(secondCode === rebuiltCode, true, 'Consecutive Vite builds must produce byte-identical dist/index.js');
                assert.equal(secondCss === rebuiltCss, true, 'Consecutive Vite builds must produce byte-identical dist/index.css');
            }
        }
    } finally {
        await rm(tmpBase, { recursive: true, force: true });
    }
});

test('Built-in Pen (floorManager) Feature Off, standalone-coexistence, and .gitignore personal-doc guards', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // 1. Verify .gitignore ignores generic docs/* scratch files while keeping docs/PERSONAL_MAINTENANCE.md unignored
    const gitignoreText = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    assert.match(gitignoreText, /^docs\/\*/m, '.gitignore should ignore docs/*');
    assert.match(gitignoreText, /^!docs\/PERSONAL_MAINTENANCE\.md$/m, '.gitignore must keep docs/PERSONAL_MAINTENANCE.md unignored');
    assert.equal(/^docs\/$/m.test(gitignoreText), false, '.gitignore must not blanket-ignore docs/ directory');

    // 2. Verify Pen lifecycle teardown in src/pen/index.ts, side-channel/Main-API/Vertex guards, and zero Save Generate coupling
    const [penEntry, distBundle, channelParamsSrc, clientSrc, chatPersistenceSrc, floorActionsSrc] = await Promise.all([
        readFile(path.join(repoRoot, 'src', 'pen', 'index.ts'), 'utf8'),
        readFile(path.join(repoRoot, 'dist', 'index.js'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'pen', 'api', 'channelParams.ts'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'pen', 'api', 'client.ts'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'pen', 'st', 'chatPersistence.ts'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'pen', 'st', 'floorActions.ts'), 'utf8'),
    ]);
    assert.match(penEntry, /const HOST_ID = 'bby-app-host'/, 'Pen Shadow host ID contract');
    assert.match(penEntry, /versionedAssetUrl\('\.\/index\.css',\s*import\.meta\.url\)/, 'Pen Shadow root CSS path contract');
    assert.match(
        penEntry,
        /export function stopPen\(\)[\s\S]*?mountWatchStop\?\.\(\)[\s\S]*?teardownSharedChannels\(\)[\s\S]*?teardownPenSettings\(\)[\s\S]*?unbindEditButtons\(\)[\s\S]*?resetPenRuntimeState\(\)[\s\S]*?app\?\.unmount\(\)[\s\S]*?document\.getElementById\(HOST_ID\)\?\.remove\(\)/,
        'stopPen() must tear down mountWatchStop, sharedChannels, penSettings, editButtons, runtime UI state, Vue app, and Shadow host',
    );
    assert.equal(penEntry.includes('pagehide'), false, 'src/pen/index.ts must not register bfcache-breaking pagehide listener');
    assert.equal(distBundle.includes('generateRaw'), false, 'dist/index.js must not invoke ST generateRaw (protects TempResponseLength & Vertex)');
    assert.equal(distBundle.includes('跟随主 API'), false, 'dist/index.js must not expose 跟随主 API in personal build');
    assert.equal(clientSrc.includes('generateRaw'), false, 'src/pen/api/client.ts must not invoke generateRaw');
    assert.match(channelParamsSrc, /export const EXCLUDABLE_MODEL_PARAMS/, 'channelParams.ts must define explicit EXCLUDABLE_MODEL_PARAMS');
    for (const forbiddenKey of ['custom_include_headers', 'reverse_proxy', 'proxy_password', 'custom_url', 'chat_completion_source']) {
        assert.equal(
            new RegExp(`'${forbiddenKey}'`).test(channelParamsSrc.slice(channelParamsSrc.indexOf('new Set(['), channelParamsSrc.indexOf(']);'))),
            false,
            `EXCLUDABLE_MODEL_PARAMS must never allow control field ${forbiddenKey}`,
        );
    }
    assert.match(clientSrc, /filterExcludeParams\(channel\.excludeParams\)/, 'client.ts must sanitize excludeParams via filterExcludeParams');
    assert.match(clientSrc, /requireValidSideChannelBaseUrl\(rawUrl,\s*\{\s*appendDefaultV1\s*\}\)/, 'client.ts must delegate URL validation to requireValidSideChannelBaseUrl');
    assert.match(clientSrc, /resolveValidEndpointUrl\(channel\.url\)/, 'client.ts must validate channel.url via resolveValidEndpointUrl');
    assert.match(clientSrc, /function parseJsonCompletion\(data: unknown\)/, 'client.ts must detect non-streaming HTTP 200 { error } envelopes');
    assert.match(chatPersistenceSrc, /\/api\/chats\/save/, 'chatPersistence.ts must verify single-chat save endpoint');
    assert.match(chatPersistenceSrc, /\/api\/chats\/group\/save/, 'chatPersistence.ts must verify group-chat save endpoint');
    assert.match(chatPersistenceSrc, /DecompressionStream\('gzip'\)/, 'chatPersistence.ts must decompress gzipped save request bodies when matching chat identity');
    assert.match(floorActionsSrc, /captureDeleteSnapshot/, 'floorActions.ts must lock target snapshot before delete confirmation');
    assert.match(floorActionsSrc, /isSameChatTarget/, 'floorActions.ts must re-verify chat identity after confirmation');
    assert.match(floorActionsSrc, /prepareNativeEditorsBeforeSlashAction/, 'floorActions.ts must protect native #curEditTextarea before /hide or /del');
    assert.match(floorActionsSrc, /\/del toolcalls=false \$\{snapshot\.deleteCount\}/, 'floorActions.ts must pass toolcalls=false with effective deleteCount');

    // 3. Execute src/floorManager.js in an isolated VM context to verify Feature Off & standalone Pen coexistence
    const floorManagerCode = await readFile(path.join(repoRoot, 'src', 'floorManager.js'), 'utf8');
    const calls = [];
    const extNames = [];
    const extSettings = { disabledExtensions: [] };
    const ctx = vm.createContext({ console: { debug: () => {} } });
    const mod = new vm.SourceTextModule(floorManagerCode, {
        context: ctx,
        identifier: path.join(repoRoot, 'src', 'floorManager.js'),
    });
    const mocks = new Map([
        ['@sillytavern/scripts/extensions', new vm.SyntheticModule(['extension_settings', 'extensionNames'], function () {
            this.setExport('extension_settings', extSettings);
            this.setExport('extensionNames', extNames);
        }, { context: ctx })],
        ['./floorDirectory.js', new vm.SyntheticModule(['configureFloorDirectory', 'installFloorDirectory', 'openFloorDirectoryDialog'], function () {
            let openCb = null;
            this.setExport('configureFloorDirectory', cfg => { openCb = cfg.open; calls.push(['configureFloorDirectory', Boolean(openCb)]); });
            this.setExport('installFloorDirectory', () => { calls.push(['installFloorDirectory']); });
            this.setExport('openFloorDirectoryDialog', () => { calls.push(['openFloorDirectoryDialog']); });
            ctx.__triggerOpen = () => openCb?.();
        }, { context: ctx })],
        ['./pen/index.ts', new vm.SyntheticModule(['openPenWindow', 'startPen', 'stopPen'], function () {
            this.setExport('openPenWindow', () => { calls.push(['openPenWindow']); });
            this.setExport('startPen', () => { calls.push(['startPen']); });
            this.setExport('stopPen', () => { calls.push(['stopPen']); });
        }, { context: ctx })],
    ]);
    await mod.link(spec => {
        const found = mocks.get(spec);
        assert.ok(found, `Unexpected import in floorManager.js: ${spec}`);
        return found;
    });
    await mod.evaluate();

    const settingsObj = { newFloorManagerEnabled: true };
    mod.namespace.configureFloorManager({ settings: settingsObj, extensionState: {}, logPrefix: '[test]', saveSettings: () => {} });
    calls.length = 0;

    // Default ON -> starts Pen and routes menu open to Pen
    mod.namespace.installFloorManager();
    ctx.__triggerOpen();
    assert.deepEqual(calls, [['installFloorDirectory'], ['startPen'], ['openPenWindow']]);

    // Feature Off -> stops Pen and routes menu open to legacy floorDirectory
    calls.length = 0;
    settingsObj.newFloorManagerEnabled = false;
    mod.namespace.applyFloorManager();
    ctx.__triggerOpen();
    assert.deepEqual(calls, [['stopPen'], ['openFloorDirectoryDialog']]);

    // Standalone ST-BaiBai-Pen / ST-BaiBai-Inkwell enabled -> built-in Pen stays stopped even when toggle is true
    calls.length = 0;
    settingsObj.newFloorManagerEnabled = true;
    extNames.push('third-party/ST-BaiBai-Inkwell');
    mod.namespace.applyFloorManager();
    ctx.__triggerOpen();
    assert.deepEqual(calls, [['stopPen'], ['openFloorDirectoryDialog']]);

    // Standalone disabled -> built-in Pen resumes
    calls.length = 0;
    extSettings.disabledExtensions.push('third-party/ST-BaiBai-Inkwell');
    mod.namespace.applyFloorManager();
    ctx.__triggerOpen();
    assert.deepEqual(calls, [['startPen'], ['openPenWindow']]);
});

test('WP-4 retired dead modules, True Feature Off fetch-hook splicing, gzip 400/415-only retry, and __baibaokuEarlyBridge boot hydration', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // 1. Dead fastBootstrap & retired keyboard-scan / Save Generate absence checks
    assert.equal(fs.existsSync(path.join(repoRoot, 'src', 'features', 'fastBootstrap.js')), false, 'fastBootstrap.js must be deleted');
    const [distBundle, entrySrc, constantsSrc, settingsHtml] = await Promise.all([
        readFile(path.join(repoRoot, 'dist', 'index.js'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'index.js'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'features', 'constants.js'), 'utf8'),
        readFile(path.join(repoRoot, 'src', 'settings.html'), 'utf8'),
    ]);
    for (const removedSymbol of ['FAST_SETTINGS_BOOTSTRAP_FETCH_KEY', 'FAST_CHARACTER_LIST_FETCH_KEY', 'fetchFastCharacterChatList', 'fastBootstrap']) {
        assert.equal(entrySrc.includes(removedSymbol), false, `src/index.js must not reference ${removedSymbol}`);
        assert.equal(constantsSrc.includes(removedSymbol), false, `src/features/constants.js must not define ${removedSymbol}`);
        assert.equal(distBundle.includes(removedSymbol), false, `dist/index.js must not bundle ${removedSymbol}`);
    }
    assert.match(
        settingsHtml,
        /id="bai_bai_toolkit_chat_keyboard_scan_reduction_enabled"[\s\S]*?disabled[\s\S]*?减少酒馆键盘扫描（Personal Stable 已禁用）/,
        'src/settings.html must lock retired keyboard scan toggle as disabled in Personal Stable',
    );
    assert.equal(distBundle.includes('BAIBAOKU_SAVE_GENERATE_DISCARD_URL'), false, 'Save Generate must remain un-bundled in dist/index.js');

    // 2. state.js boot hydration from __baibaokuEarlyBridge & baibaokuOwnedSettingKeys persistence strip
    {
        const extSettings = {
            baiBaiToolkit: {
                chatKeyboardScanReductionEnabled: true,
                fastCharacterListEnabled: true,
                tokenizerBulkCountEnabled: true,
                baibaokuSettingsAccelerationEnabled: true,
                baibaokuLazyThemeLoadingEnabled: true,
                extensionManifestBundleEnabled: true,
                recentChatListAccelerationEnabled: true,
                saveRequestGzipEnabled: false,
            },
        };
        let saveCount = 0;
        const stateCtx = vm.createContext({
            console,
            URL,
            __baibaokuEarlyBridge: {
                isSettingsAccelerationEnabled: () => false,
                isLazyThemeLoadingEnabled: () => false,
                isExtensionManifestBundleEnabled: () => false,
                isCharacterListAccelerationEnabled: () => false,
                isRecentChatListAccelerationEnabled: () => false,
                isTokenizerBulkCountEnabled: () => false,
            },
        });
        stateCtx.globalThis = stateCtx;
        stateCtx.window = stateCtx;
        const stateMod = await loadVmModule('../src/features/state.js', stateCtx, {
            '@sillytavern/script': { saveSettingsDebounced: () => { saveCount += 1; } },
            '@sillytavern/scripts/extensions': { extension_settings: extSettings },
            './constants.js': { EXTENSION_KEY: 'bai-bai-toolkit', SETTINGS_KEY: 'baiBaiToolkit' },
        });
        stateMod.initializeSettings();
        assert.equal(stateMod.settings.chatKeyboardScanReductionEnabled, false, 'chatKeyboardScanReductionEnabled must stay forced false');
        assert.equal(stateMod.settings.baibaokuSettingsAccelerationEnabled, false, '__baibaokuEarlyBridge hydrates baibaokuSettingsAccelerationEnabled');
        assert.equal(stateMod.settings.baibaokuLazyThemeLoadingEnabled, false, '__baibaokuEarlyBridge hydrates baibaokuLazyThemeLoadingEnabled');
        assert.equal(stateMod.settings.extensionManifestBundleEnabled, false, '__baibaokuEarlyBridge hydrates extensionManifestBundleEnabled');
        assert.equal(stateMod.settings.fastCharacterListEnabled, false, '__baibaokuEarlyBridge hydrates fastCharacterListEnabled');
        assert.equal(stateMod.settings.recentChatListAccelerationEnabled, false, '__baibaokuEarlyBridge hydrates recentChatListAccelerationEnabled');
        assert.equal(stateMod.settings.tokenizerBulkCountEnabled, false, '__baibaokuEarlyBridge hydrates tokenizerBulkCountEnabled');
        assert.equal(stateMod.settings.saveRequestGzipEnabled, false, 'frontend-owned setting preserved');

        saveCount = 0;
        stateMod.saveExtensionSettings();
        assert.equal(saveCount, 1);
        for (const strippedKey of [
            'baibaokuSettingsAccelerationEnabled',
            'baibaokuLazyThemeLoadingEnabled',
            'extensionManifestBundleEnabled',
            'fastCharacterListEnabled',
            'recentChatListAccelerationEnabled',
            'tokenizerBulkCountEnabled',
            'chatKeyboardScanReductionEnabled',
        ]) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(extSettings.baiBaiToolkit, strippedKey),
                false,
                `extension_settings.baiBaiToolkit must strip ${strippedKey}`,
            );
        }
    }

    // 3. gzipHook.js True Feature Off splicing + HTTP 400/415-only uncompressed retry
    {
        const calls = [];
        let nextBehavior = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
        const baseFetch = async (input, init) => {
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
            calls.push({ url: String(input), encoding: headers.get('content-encoding'), body: init?.body });
            return nextBehavior(calls.length);
        };
        const gzipSettings = { saveRequestGzipEnabled: false };
        const gzipCtx = vm.createContext({
            console: { debug: () => {}, warn: () => {} },
            CompressionStream,
            Response,
            Request,
            Headers,
            URL,
            URLSearchParams,
            Blob,
            FormData,
            ReadableStream,
            ArrayBuffer,
            Uint8Array,
            performance,
            fetch: baseFetch,
            location: { origin: 'https://st.example.com', href: 'https://st.example.com/' },
        });
        gzipCtx.globalThis = gzipCtx;
        gzipCtx.window = gzipCtx;

        const gzipMod = await loadVmModule('../src/features/gzipHook.js', gzipCtx, {
            './constants.js': {
                LOG_PREFIX: '[test]',
                SAVE_REQUEST_GZIP_FETCH_KEY: '__baiBaiToolkitSaveRequestGzipFetch',
                SAVE_REQUEST_GZIP_PATHS: new Set(['/api/chats/save']),
            },
            './perfTrace.js': {
                getPerformanceTraceStackSummary: () => '',
                recordPerformanceTraceGzipCompression: () => {},
            },
            './state.js': { settings: gzipSettings },
        });

        // Disabled at boot -> never wraps globalThis.fetch
        gzipMod.syncSaveRequestGzipFetchHook();
        assert.equal(gzipCtx.fetch, baseFetch, 'Disabled gzipHook must leave globalThis.fetch untouched');

        // Enabled -> wraps globalThis.fetch
        gzipSettings.saveRequestGzipEnabled = true;
        gzipMod.syncSaveRequestGzipFetchHook();
        const installedGzipFetch = gzipCtx.fetch;
        assert.notEqual(installedGzipFetch, baseFetch, 'Enabled gzipHook must wrap globalThis.fetch');

        // Stacked outer wrapper -> disabling gzipHook splices out from middle cleanly
        const outerState = { rawOriginalFetch: installedGzipFetch };
        const outerWrapper = function (...args) {
            return outerWrapper.__baiBaiToolkitOriginalFetch.apply(this, args);
        };
        outerWrapper.__baiBaiToolkitOriginalFetch = installedGzipFetch;
        outerWrapper.__baiBaiToolkitHookState = outerState;
        gzipCtx.fetch = outerWrapper;

        gzipSettings.saveRequestGzipEnabled = false;
        gzipMod.syncSaveRequestGzipFetchHook();
        assert.equal(gzipCtx.fetch, outerWrapper, 'Outer wrapper stays intact when inner gzipHook is disabled');
        assert.equal(outerWrapper.__baiBaiToolkitOriginalFetch, baseFetch, 'Inner gzipHook spliced out cleanly');
        assert.equal(outerState.rawOriginalFetch, baseFetch, 'Outer hookState.rawOriginalFetch updated cleanly');

        // Reset to clean gzipHook for retry policy checks
        gzipCtx.fetch = baseFetch;
        gzipSettings.saveRequestGzipEnabled = true;
        gzipMod.syncSaveRequestGzipFetchHook();

        // 415 Unsupported Media Type -> retries once uncompressed
        calls.length = 0;
        nextBehavior = attempt => attempt === 1
            ? new Response('Unsupported Media Type', { status: 415 })
            : new Response(JSON.stringify({ ok: true }), { status: 200 });
        const res415 = await gzipCtx.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ chat: [] }) });
        assert.equal(res415.status, 200);
        assert.equal(calls.length, 2, 'HTTP 415 must trigger uncompressed fallback retry');
        assert.equal(calls[0].encoding, 'gzip');
        assert.equal(calls[1].encoding, null);

        // 500 Internal Server Error -> MUST NOT retry uncompressed
        calls.length = 0;
        nextBehavior = () => new Response('Disk full', { status: 500 });
        const res500 = await gzipCtx.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ chat: [] }) });
        assert.equal(res500.status, 500);
        assert.equal(calls.length, 1, 'HTTP 500 must NEVER double-POST uncompressed');

        // Post-dispatch network TypeError -> MUST NOT retry uncompressed
        calls.length = 0;
        nextBehavior = () => Promise.reject(new TypeError('Failed to fetch'));
        await assert.rejects(
            () => gzipCtx.fetch('/api/chats/save', { method: 'POST', body: JSON.stringify({ chat: [] }) }),
            /Failed to fetch/,
        );
        assert.equal(calls.length, 1, 'Post-dispatch network rejection must NEVER double-POST uncompressed');
    }

    // 4. generateRetry.js, perfTrace.js, chatList.js & welcomeRecent.js True Feature Off checks
    {
        const baseFetch = async () => new Response('{}', { status: 200 });
        const listeners = new Map();
        const eventSource = {
            on: (evt, fn) => { listeners.set(evt, (listeners.get(evt) || 0) + 1); eventSource.__lastFn = fn; },
            removeListener: evt => { listeners.set(evt, Math.max(0, (listeners.get(evt) || 0) - 1)); },
        };
        const retrySettings = { generateRetryEnabled: false, generateBlacklistEnabled: false, generateSoundEnabled: false };
        const retryCtx = vm.createContext({
            console: { debug: () => {}, warn: () => {}, info: () => {} },
            fetch: baseFetch,
            setTimeout,
            clearTimeout,
            Headers,
            Request,
            Response,
            URL,
            location: { origin: 'https://st.example.com' },
        });
        retryCtx.globalThis = retryCtx;
        retryCtx.window = retryCtx;

        const retryMod = await loadVmModule('../src/features/generateRetry.js', retryCtx, {
            '@sillytavern/script': {
                eventSource,
                event_types: { GENERATION_STARTED: 'gs', GENERATION_STOPPED: 'gx', GENERATION_ENDED: 'ge', CHAT_CHANGED: 'cc', CHARACTER_MESSAGE_RENDERED: 'cmr', USER_MESSAGE_RENDERED: 'umr', MESSAGE_SWIPED: 'ms', MESSAGE_UPDATED: 'mu' },
            },
            './constants.js': featureConstants,
            './generateRequest.js': generateRequest,
            './generationLifecycle.js': {
                getGenerationStopEpoch: () => 0,
                isCurrentGenerationStopped: () => false,
                subscribeGenerationStop: () => () => {},
            },
            './gzipHook.js': gzipHook,
            './state.js': { extensionState: {}, settings: retrySettings },
            './util.js': featureUtil,
        });

        retryMod.syncGenerateRetryFetchHook();
        assert.equal(retryCtx.fetch, baseFetch, 'Disabled generateRetry must not wrap fetch');
        assert.equal([...listeners.values()].reduce((a, b) => a + b, 0), 0, 'Disabled generateRetry must attach zero ST listeners');

        retrySettings.generateRetryEnabled = true;
        retryMod.syncGenerateRetryFetchHook();
        assert.notEqual(retryCtx.fetch, baseFetch, 'Enabling generateRetry installs fetch hook');
        assert.equal([...listeners.values()].reduce((a, b) => a + b, 0) > 0, true, 'Enabling generateRetry attaches ST lifecycle listeners');

        retrySettings.generateRetryEnabled = false;
        retryMod.syncGenerateRetryFetchHook();
        assert.equal(retryCtx.fetch, baseFetch, 'Disabling generateRetry splices out fetch hook');
        assert.equal([...listeners.values()].reduce((a, b) => a + b, 0), 0, 'Disabling generateRetry removes ST lifecycle listeners');
    }

    {
        const baseFetch = async () => new Response('{}', { status: 200 });
        const removedClicks = [];
        const addedClicks = [];
        const chatState = {};
        const chatSettings = { fastChatListEnabled: false, welcomeRecentChatDirectOpenEnabled: true };
        const chatCtx = vm.createContext({
            console: { debug: () => {}, warn: () => {} },
            fetch: baseFetch,
            Headers,
            Request,
            Response,
            URL,
            location: { origin: 'https://st.example.com' },
            document: {
                getElementById: () => null,
                addEventListener: (type, fn, cap) => { addedClicks.push([type, fn, cap]); },
                removeEventListener: (type, fn, cap) => { removedClicks.push([type, fn, cap]); },
            },
        });
        chatCtx.globalThis = chatCtx;
        chatCtx.window = chatCtx;

        const chatListMod = await loadVmModule('../src/chat/chatList.js', chatCtx, {
            '@sillytavern/script': { getRequestHeaders: () => ({}) },
            './constants.js': chatConstants,
            './state.js': { LOG_PREFIX: '[test]', extensionState: chatState, settings: chatSettings },
        });
        chatListMod.applyFastChatListFetchOptimization();
        assert.equal(chatCtx.fetch, baseFetch, 'Disabled fastChatListEnabled must not wrap fetch');
        chatSettings.fastChatListEnabled = true;
        chatListMod.applyFastChatListFetchOptimization();
        assert.notEqual(chatCtx.fetch, baseFetch, 'Enabled fastChatListEnabled wraps fetch');
        chatSettings.fastChatListEnabled = false;
        chatListMod.applyFastChatListFetchOptimization();
        assert.equal(chatCtx.fetch, baseFetch, 'Disabling fastChatListEnabled restores fetch');

        const welcomeMod = await loadVmModule('../src/chat/welcomeRecent.js', chatCtx, {
            '@sillytavern/script': { characters: [], getCurrentChatId: () => '', openCharacterChat: async () => {}, saveSettingsDebounced: () => {}, selectCharacterById: async () => {}, setActiveCharacter: () => {}, this_chid: undefined },
            '@sillytavern/scripts/i18n': { t: s => s },
            './constants.js': chatConstants,
            './hostAliases.js': { createOrEditCharacter: () => {}, unshallowCharacter: async () => {} },
            './state.js': { LOG_PREFIX: '[test]', extensionState: chatState, settings: chatSettings },
        });
        welcomeMod.applyWelcomeRecentChatDirectOpenOptimization();
        assert.equal(addedClicks.length, 1, 'Enabled welcomeRecentChatDirectOpen attaches capture click listener');
        chatSettings.welcomeRecentChatDirectOpenEnabled = false;
        welcomeMod.applyWelcomeRecentChatDirectOpenOptimization();
        assert.equal(removedClicks.length, 1, 'Disabled welcomeRecentChatDirectOpen removes capture click listener');
    }
});

test('WP-3: fetchPipeline preserves topological order across gzipHook re-enable and concurrent saveToggle waiters', async () => {
    // 1. Static policy guard: only src/features/fetchPipeline.js (excluding unassembled saveGenerate.js and unit tests) may assign globalThis.fetch
    {
        const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
        const offenders = [];
        async function walkSrc(dir) {
            for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walkSrc(full);
                    continue;
                }
                if (!/\.(?:[cm]?js|ts|vue)$/.test(entry.name)) continue;
                if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) continue;
                const rel = path.relative(srcRoot, full).replace(/\\/g, '/');
                if (rel === 'features/fetchPipeline.js' || rel === 'features/saveGenerate.js') continue;
                const text = await readFile(full, 'utf8');
                if (/\b(?:globalThis|window)\.fetch\s*=/.test(text)) {
                    offenders.push(rel);
                }
            }
        }
        await walkSrc(srcRoot);
        assert.deepEqual(offenders, [], `Unexpected direct globalThis/window.fetch assignments outside fetchPipeline.js: ${offenders.join(', ')}`);
    }

    // 2. theme.js + autoBackup.js + gzipHook.js -> disable gzipHook -> re-enable gzipHook -> plain JSON still seen by theme & autoBackup while wire sees gzip!
    {
        const wireCalls = [];
        const backupPayloads = [];
        const baseFetch = async (input, init) => {
            const url = String(input);
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
            wireCalls.push({ url, encoding: headers.get('content-encoding'), body: init?.body });
            if (url === '/backups/save') {
                backupPayloads.push(JSON.parse(String(init?.body || '{}')));
                return new Response(JSON.stringify({ ok: true, data: { fileName: 'PresetReenabled-1.json' } }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const pipeCtx = vm.createContext({
            console: { debug: () => {}, warn: () => {} },
            CompressionStream,
            Response,
            Request,
            Headers,
            URL,
            URLSearchParams,
            Blob,
            FormData,
            ReadableStream,
            ArrayBuffer,
            Uint8Array,
            performance,
            setTimeout,
            clearTimeout,
            fetch: baseFetch,
            location: { origin: 'https://st.example.com', href: 'https://st.example.com/' },
        });
        pipeCtx.globalThis = pipeCtx;
        pipeCtx.window = pipeCtx;

        const pipelineMod = await loadVmModule('../src/features/fetchPipeline.js', pipeCtx);
        assert.ok(
            pipelineMod.FETCH_PIPELINE_SLOT_ORDER.indexOf('extensionOps') < pipelineMod.FETCH_PIPELINE_SLOT_ORDER.indexOf('updateDiagnostics'),
            'extensionOps must precede updateDiagnostics so X-Baibaoku-Job-Id header is attached first',
        );

        const gzipSettings = { saveRequestGzipEnabled: true };
        const gzipMod = await loadVmModule('../src/features/gzipHook.js', pipeCtx, {
            './constants.js': {
                LOG_PREFIX: '[test]',
                SAVE_REQUEST_GZIP_FETCH_KEY: '__baiBaiToolkitSaveRequestGzipFetch',
                SAVE_REQUEST_GZIP_PATHS: new Set(['/api/chats/save', '/api/themes/save', '/api/presets/save']),
            },
            './perfTrace.js': {
                getPerformanceTraceStackSummary: () => '',
                recordPerformanceTraceGzipCompression: () => {},
            },
            './state.js': { settings: gzipSettings },
        });

        const themeMod = await loadVmModule('../src/features/theme.js', pipeCtx, {
            '@sillytavern/script': { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced: () => {} },
            '@sillytavern/scripts/power-user': { applyPowerUserSettings: () => {}, power_user: {} },
            '@sillytavern/scripts/utils': { cancelDebounce: () => {} },
            '../scrollTopPatch.js': { registerScrollTopWriteInterceptor: () => () => {} },
            './constants.js': {
                BAIBAOKU_EARLY_BRIDGE_KEY: '__bbkEarly',
                BAIBAOKU_THEME_COLOR_BINDINGS: [],
                BAIBAOKU_THEME_GET_URL: '/api/plugins/baibaoku/v1/themes/get',
                BAIBAOKU_THEME_LOADING_FIXED_CLASS: 'fixed',
                BAIBAOKU_THEME_LOADING_HOST_CLASS: 'host',
                BAIBAOKU_THEME_LOADING_OVERLAY_CLASS: 'overlay',
                BAIBAOKU_THEME_LOADING_SPINNER_CLASS: 'spinner',
                BAIBAOKU_THEME_LOADING_STYLE_ID: 'style',
                BAIBAOKU_THEME_POWER_USER_KEYS: [],
                CUSTOM_CSS_CODEMIRROR_EDITOR_KEY: '__cm',
                CUSTOM_CSS_THEME_SYNC_SETTLE_DELAYS_MS: [],
                LAZY_THEME_CHANGE_GUARD_KEY: '__lazyThemeGuard',
                LOG_PREFIX: '[test]',
                THEME_APPLY_REFLOW_GUARD_METRICS: [],
                THEME_APPLY_REFLOW_GUARD_PATCH_KEY: '__reflowPatch',
                THEME_APPLY_REFLOW_GUARD_WINDOW_MS: 50,
                THEME_CACHE_SYNC_FETCH_KEY: '__themeCacheFetch',
                THEME_DELETE_PATH: '/api/themes/delete',
                THEME_MANAGER_BACKGROUND_BINDINGS_KEY: '__bgBindings',
                THEME_MANAGER_BACKGROUND_SELECTOR: '#bg',
                THEME_MANAGER_PANEL_SELECTOR: '#panel',
                THEME_MANAGER_THEME_ITEM_SELECTOR: '.item',
                THEME_SAVE_PATH: '/api/themes/save',
            },
            './customCss.js': { syncCustomCssStateFromSettings: () => {} },
            './gzipHook.js': gzipMod,
            './state.js': { extensionState: {}, settings: {} },
        });

        const autoBackupMod = await loadVmModule('../src/preset/autoBackup.js', pipeCtx, {
            '@sillytavern/script': {
                event_types: {},
                eventSource: { on: () => {} },
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            },
            '@sillytavern/scripts/openai': { oai_settings: {} },
            './backupRetention.js': { schedulePresetBackupCleanup: () => {} },
            './constants.js': {
                PRESET_AUTO_BACKUP_FETCH_KEY: '__presetAutoBackupFetch',
                PRESET_AUTO_BACKUP_RENAME_HANDLER_KEY: '__presetRenameHandler',
                PRESET_BACKUP_SAVE_URL: '/backups/save',
                PRESET_RENAME_SAVE_GATE_TIMEOUT_MS: 500,
                PRESET_SAVE_URL: '/api/presets/save',
            },
            './pendingChanges.js': {
                clearPendingPresetPromptChangesForSavedRevision: () => {},
                getPresetPromptSaveRevision: () => 1,
            },
            './state.js': {
                LOG_PREFIX: '[test]',
                extensionState: {},
                settings: { presetAutoBackupEnabled: true },
            },
        });

        themeMod.installThemePageCacheSyncFetchHook();
        autoBackupMod.installPresetAutoBackupFetchHook();
        gzipMod.syncSaveRequestGzipFetchHook();

        // Disable gzipHook -> removed from pipeline & 100% inactive
        gzipSettings.saveRequestGzipEnabled = false;
        gzipMod.syncSaveRequestGzipFetchHook();
        assert.equal(pipelineMod.hasFetchPipelineSlot('saveRequestGzip'), false, 'Disabled gzipHook must unregister saveRequestGzip slot');

        wireCalls.length = 0;
        await pipeCtx.fetch('/api/themes/save', {
            method: 'POST',
            body: JSON.stringify({ name: 'NordDisabled', blur_strength: 4 }),
        });
        assert.equal(wireCalls.length, 1);
        assert.equal(wireCalls[0].encoding, null, 'Disabled gzipHook must send plain JSON on wire');
        assert.equal(typeof wireCalls[0].body, 'string');

        // Re-enable gzipHook AFTER theme.js & autoBackup.js -> MUST still run INNER to themeCacheSync & presetAutoBackup!
        gzipSettings.saveRequestGzipEnabled = true;
        gzipMod.syncSaveRequestGzipFetchHook();
        assert.deepEqual(
            [...pipelineMod.getActiveFetchPipelineSlots()],
            ['presetAutoBackup', 'themeCacheSync', 'saveRequestGzip'],
            'Re-enabled saveRequestGzip must stay inner to presetAutoBackup and themeCacheSync',
        );

        wireCalls.length = 0;
        await pipeCtx.fetch('/api/themes/save', {
            method: 'POST',
            body: JSON.stringify({ name: 'NordReenabled', blur_strength: 12 }),
        });
        assert.equal(wireCalls.length, 1);
        assert.equal(wireCalls[0].encoding, 'gzip', 'Re-enabled gzipHook must compress /api/themes/save on wire');
        assert.equal(wireCalls[0].body instanceof Blob && wireCalls[0].body.size > 0, true);
        assert.deepEqual(
            { ...themeMod.baibaokuThemePageCache.get('NordReenabled') },
            { name: 'NordReenabled', blur_strength: 12 },
            'theme.js must still inspect plain JSON body before inner gzipHook compresses it',
        );

        wireCalls.length = 0;
        backupPayloads.length = 0;
        await pipeCtx.fetch('/api/presets/save', {
            method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'PresetReenabled', preset: { temperature: 0.85 } }),
        });
        await new Promise(resolve => setTimeout(resolve, 20));

        const presetSaveWire = wireCalls.find(item => item.url === '/api/presets/save');
        assert.ok(presetSaveWire, '/api/presets/save must reach wire');
        assert.equal(presetSaveWire.encoding, 'gzip', 'Re-enabled gzipHook must compress /api/presets/save on wire');
        assert.equal(presetSaveWire.body instanceof Blob && presetSaveWire.body.size > 0, true);
        assert.equal(backupPayloads.length, 1, 'autoBackup.js must still read plain JSON /api/presets/save and dispatch /backups/save');
        assert.equal(backupPayloads[0].name, 'PresetReenabled');
        assert.deepEqual(backupPayloads[0].preset, { temperature: 0.85 });
    }

    // 3. saveToggle.js waitForOpenAiPresetUpdateRequest concurrent with gzipHook toggling off/on never corrupts globalThis.fetch
    {
        const baseFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
        const toggleCtx = vm.createContext({
            console: { debug: () => {}, warn: () => {} },
            CompressionStream,
            Response,
            Request,
            Headers,
            URL,
            URLSearchParams,
            Blob,
            FormData,
            ReadableStream,
            ArrayBuffer,
            Uint8Array,
            performance,
            setTimeout,
            clearTimeout,
            fetch: baseFetch,
            location: { origin: 'https://st.example.com', href: 'https://st.example.com/' },
        });
        toggleCtx.globalThis = toggleCtx;
        toggleCtx.window = toggleCtx;

        const pipelineMod = await loadVmModule('../src/features/fetchPipeline.js', toggleCtx);
        const gzipSettings = { saveRequestGzipEnabled: true };
        const gzipMod = await loadVmModule('../src/features/gzipHook.js', toggleCtx, {
            './constants.js': {
                LOG_PREFIX: '[test]',
                SAVE_REQUEST_GZIP_FETCH_KEY: '__baiBaiToolkitSaveRequestGzipFetch',
                SAVE_REQUEST_GZIP_PATHS: new Set(['/api/presets/save']),
            },
            './perfTrace.js': {
                getPerformanceTraceStackSummary: () => '',
                recordPerformanceTraceGzipCompression: () => {},
            },
            './state.js': { settings: gzipSettings },
        });
        const saveToggleMod = await loadVmModule('../src/preset/saveToggle.js', toggleCtx, {
            '@sillytavern/scripts/openai': { oai_settings: {}, promptManager: {} },
            '@sillytavern/scripts/PromptManager': { INJECTION_POSITION: {} },
            './codeMirror.js': { flushPresetPromptCodeMirrorEditor: () => {} },
            './constants.js': {
                PRESET_PROMPT_MANAGER_LIST_SELECTOR: '#list',
                PRESET_PROMPT_MANAGER_SAVE_SELECTOR: '#save',
                PRESET_SAVE_HANDLER_KEY: '__saveHandler',
                PRESET_TOGGLE_HANDLER_KEY: '__toggleHandler',
                refreshPromptManagerTokensDebounced: () => {},
            },
            './pendingChanges.js': {
                flushPendingPresetPromptChanges: async () => {},
                getChatCompletionPresetFromSettings: () => ({}),
                getPresetPromptSaveRevision: () => 1,
                markOpenAiPresetSavePending: () => {},
                markPresetPromptServiceSettingsSavePending: () => {},
                saveOpenAiPresetSnapshot: async () => {},
                syncOpenAiPromptManagerStateToSettings: () => {},
                updatePresetVuePromptItemEnabled: () => false,
            },
            './state.js': { LOG_PREFIX: '[test]', extensionState: {}, settings: {} },
            './switchFast.js': { updatePresetEffectiveTokenHeaderDisplay: () => {} },
            './util.js': { isPresetGroupingEnabled: () => false },
            './vueList.js': {
                isPresetVuePromptListManagerActive: () => false,
                markPresetVuePromptListSyncSignatureCurrent: () => {},
            },
        });

        gzipMod.syncSaveRequestGzipFetchHook();

        const waiterA = saveToggleMod.waitForOpenAiPresetUpdateRequest('PresetA');
        const waiterB = saveToggleMod.waitForOpenAiPresetUpdateRequest('PresetB');

        // Toggle gzipHook off -> on -> off while both ephemeral waiters are active!
        gzipSettings.saveRequestGzipEnabled = false;
        gzipMod.syncSaveRequestGzipFetchHook();
        gzipSettings.saveRequestGzipEnabled = true;
        gzipMod.syncSaveRequestGzipFetchHook();

        await toggleCtx.fetch('/api/presets/save', {
            method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'PresetA', preset: {} }),
        });
        assert.equal(await waiterA, true, 'waiterA must resolve true for PresetA even while gzipHook toggled');

        gzipSettings.saveRequestGzipEnabled = false;
        gzipMod.syncSaveRequestGzipFetchHook();

        await toggleCtx.fetch('/api/presets/save', {
            method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'PresetB', preset: {} }),
        });
        assert.equal(await waiterB, true, 'waiterB must resolve true for PresetB');

        assert.deepEqual([...pipelineMod.getActiveFetchPipelineSlots()], [], 'All pipeline slots must be empty after waiters and gzipHook exit');
        assert.equal(toggleCtx.fetch, baseFetch, 'globalThis.fetch must cleanly restore to baseFetch with zero dangling wrappers');
    }
});
