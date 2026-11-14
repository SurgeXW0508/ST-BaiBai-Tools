const FETCH_PIPELINE_KEY = '__baiBaiToolkitFetchPipeline';

const FETCH_PIPELINE_SLOT_ORDER = Object.freeze([
    'chatSaveObserver',
    'presetSaveToggle',
    'presetAutoBackup',
    'reduceLoadedFloors',
    'themeCacheSync',
    'extensionOps',
    'updateDiagnostics',
    'generateRetry',
    'perfTrace',
    'saveRequestGzip',
    'fastChatBackups',
    'fastChatSearch',
]);

const SLOT_PRIORITY_MAP = new Map(
    FETCH_PIPELINE_SLOT_ORDER.map((slotName, index) => [slotName, index]),
);

const DYNAMIC_PRESET_SAVE_TOGGLE_PREFIX = 'presetSaveToggle:';

function resolveSlotPriority(slotId) {
    if (typeof slotId !== 'string' || !slotId) {
        throw new TypeError(`Invalid fetch pipeline slot id: ${String(slotId)}`);
    }
    const exact = SLOT_PRIORITY_MAP.get(slotId);
    if (exact !== undefined) {
        return exact;
    }
    if (slotId.startsWith(DYNAMIC_PRESET_SAVE_TOGGLE_PREFIX) && slotId.length > DYNAMIC_PRESET_SAVE_TOGGLE_PREFIX.length) {
        return SLOT_PRIORITY_MAP.get('presetSaveToggle');
    }
    throw new Error(`Unknown fetch pipeline slot: ${slotId}`);
}

function isFetchWrapperInChain(root, target) {
    if (typeof root !== 'function' || typeof target !== 'function') {
        return false;
    }
    const visited = new Set();
    let cursor = root;
    while (typeof cursor === 'function' && !visited.has(cursor)) {
        if (cursor === target) {
            return true;
        }
        visited.add(cursor);
        cursor = cursor.__baiBaiToolkitOriginalFetch;
    }
    return false;
}

function spliceFetchWrapperOut(wrappedFetch, rawOriginalFetch) {
    if (typeof wrappedFetch !== 'function' || typeof rawOriginalFetch !== 'function') {
        return false;
    }
    if (globalThis.fetch === wrappedFetch) {
        globalThis.fetch = rawOriginalFetch;
        return true;
    }
    const visited = new Set();
    let cursor = globalThis.fetch;
    while (typeof cursor === 'function' && !visited.has(cursor)) {
        visited.add(cursor);
        if (cursor.__baiBaiToolkitOriginalFetch === wrappedFetch) {
            cursor.__baiBaiToolkitOriginalFetch = rawOriginalFetch;
            if (cursor.__baiBaiToolkitHookState && typeof cursor.__baiBaiToolkitHookState === 'object') {
                cursor.__baiBaiToolkitHookState.rawOriginalFetch = rawOriginalFetch;
                cursor.__baiBaiToolkitHookState.originalFetch = rawOriginalFetch.bind(globalThis);
            }
            return true;
        }
        cursor = cursor.__baiBaiToolkitOriginalFetch;
    }
    return false;
}

function getFetchPipelineState() {
    const existing = globalThis[FETCH_PIPELINE_KEY];
    if (existing && typeof existing === 'object' && existing.slots instanceof Map) {
        return existing;
    }

    const state = {
        slots: new Map(),
        sortedEntries: [],
        registrationSeq: 0,
        dispatcherFetch: null,
        rawOriginalFetch: null,
        originalFetch: null,
    };
    globalThis[FETCH_PIPELINE_KEY] = state;
    return state;
}

function rebuildSortedEntries(state) {
    state.sortedEntries = Array.from(state.slots.values()).sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return a.seq - b.seq;
    });
}

function resolveUnderlyingFetch(state) {
    const candidate = state.dispatcherFetch?.__baiBaiToolkitOriginalFetch || state.rawOriginalFetch;
    if (typeof candidate === 'function') {
        return candidate;
    }
    return typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
}

function dispatchFetchPipeline(state, thisArg, input, init) {
    const entries = state.sortedEntries;
    const invokeTarget = thisArg ?? globalThis;

    const invokeAt = (index, currentInput, currentInit) => {
        if (index >= entries.length) {
            const underlying = resolveUnderlyingFetch(state);
            if (typeof underlying !== 'function') {
                return Promise.reject(new TypeError('globalThis.fetch is not a function'));
            }
            return underlying.call(invokeTarget, currentInput, currentInit);
        }

        const entry = entries[index];
        let nextCalled = false;
        const nextFetch = (nextInput, nextInit) => {
            if (nextCalled) {
                return invokeAt(index + 1, nextInput, nextInit);
            }
            nextCalled = true;
            return invokeAt(index + 1, nextInput, nextInit);
        };

        return entry.handler(currentInput, currentInit, nextFetch, invokeTarget);
    };

    return invokeAt(0, input, init);
}

function ensureDispatcherMounted(state) {
    if (typeof globalThis.fetch !== 'function') {
        return false;
    }

    if (state.dispatcherFetch && isFetchWrapperInChain(globalThis.fetch, state.dispatcherFetch)) {
        return true;
    }

    const rawOriginalFetch = globalThis.fetch;
    const dispatcherFetch = function baiBaiToolkitFetchDispatcher(input, init) {
        return dispatchFetchPipeline(state, this, input, init);
    };

    dispatcherFetch.__baiBaiToolkitFetchDispatcher = true;
    dispatcherFetch.__baiBaiToolkitOriginalFetch = rawOriginalFetch;
    dispatcherFetch.__baiBaiToolkitHookState = state;

    state.rawOriginalFetch = rawOriginalFetch;
    state.originalFetch = rawOriginalFetch.bind(globalThis);
    state.dispatcherFetch = dispatcherFetch;
    globalThis.fetch = dispatcherFetch;
    return true;
}

function unmountDispatcherIfEmpty(state) {
    if (state.slots.size > 0 || !state.dispatcherFetch) {
        return false;
    }

    const underlying = state.dispatcherFetch.__baiBaiToolkitOriginalFetch || state.rawOriginalFetch;
    const spliced = spliceFetchWrapperOut(state.dispatcherFetch, underlying);
    if (spliced || !isFetchWrapperInChain(globalThis.fetch, state.dispatcherFetch)) {
        state.dispatcherFetch = null;
        state.rawOriginalFetch = null;
        state.originalFetch = null;
    }
    return spliced;
}

function registerFetchPipelineSlot(slotId, handler) {
    const priority = resolveSlotPriority(slotId);
    if (typeof handler !== 'function') {
        throw new TypeError(`Fetch pipeline handler for '${slotId}' must be a function`);
    }
    if (typeof globalThis.fetch !== 'function') {
        return false;
    }

    const state = getFetchPipelineState();
    const existingEntry = state.slots.get(slotId);
    if (existingEntry) {
        existingEntry.handler = handler;
    } else {
        state.slots.set(slotId, {
            slotId,
            priority,
            seq: ++state.registrationSeq,
            handler,
        });
    }
    rebuildSortedEntries(state);
    return ensureDispatcherMounted(state);
}

function unregisterFetchPipelineSlot(slotId) {
    if (typeof slotId !== 'string' || !slotId) {
        return false;
    }
    const state = globalThis[FETCH_PIPELINE_KEY];
    if (!state || !(state.slots instanceof Map)) {
        return false;
    }

    const deleted = state.slots.delete(slotId);
    if (deleted) {
        rebuildSortedEntries(state);
    }
    const unmounted = unmountDispatcherIfEmpty(state);
    return deleted || unmounted;
}

function hasFetchPipelineSlot(slotId) {
    const state = globalThis[FETCH_PIPELINE_KEY];
    if (!state || !(state.slots instanceof Map) || !state.slots.has(slotId)) {
        return false;
    }
    return Boolean(state.dispatcherFetch && isFetchWrapperInChain(globalThis.fetch, state.dispatcherFetch));
}

function getActiveFetchPipelineSlots() {
    const state = globalThis[FETCH_PIPELINE_KEY];
    if (!state || !Array.isArray(state.sortedEntries)) {
        return [];
    }
    return state.sortedEntries.map(entry => entry.slotId);
}

function callUnderlyingFetch(input, init, thisArg = globalThis) {
    const state = globalThis[FETCH_PIPELINE_KEY];
    const underlying = state && state.dispatcherFetch && isFetchWrapperInChain(globalThis.fetch, state.dispatcherFetch)
        ? resolveUnderlyingFetch(state)
        : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

    if (typeof underlying !== 'function') {
        return Promise.reject(new TypeError('globalThis.fetch is not a function'));
    }
    return underlying.call(thisArg ?? globalThis, input, init);
}

function resetFetchPipeline() {
    const state = globalThis[FETCH_PIPELINE_KEY];
    if (!state || !(state.slots instanceof Map)) {
        return false;
    }
    state.slots.clear();
    state.sortedEntries = [];
    return unmountDispatcherIfEmpty(state);
}

export {
    FETCH_PIPELINE_KEY,
    FETCH_PIPELINE_SLOT_ORDER,
    callUnderlyingFetch,
    getActiveFetchPipelineSlots,
    hasFetchPipelineSlot,
    isFetchWrapperInChain,
    registerFetchPipelineSlot,
    resetFetchPipeline,
    spliceFetchWrapperOut,
    unregisterFetchPipelineSlot,
};
