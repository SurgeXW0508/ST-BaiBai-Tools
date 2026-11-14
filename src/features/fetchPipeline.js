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
        pinnedAboveFetch: null,
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

function invokePromiseSafe(fn, thisArg, input, init) {
    if (typeof fn !== 'function') {
        return Promise.reject(new TypeError('globalThis.fetch is not a function'));
    }
    try {
        return Promise.resolve(fn.call(thisArg, input, init));
    } catch (syncError) {
        return Promise.reject(syncError);
    }
}

function dispatchFetchPipeline(state, thisArg, input, init, capturedUnderlyingFetch) {
    const entries = state.sortedEntries;
    const invokeTarget = thisArg ?? globalThis;

    const invokeAt = (index, currentInput, currentInit) => {
        if (index >= entries.length) {
            return invokePromiseSafe(capturedUnderlyingFetch, invokeTarget, currentInput, currentInit);
        }

        const entry = entries[index];
        const nextFetch = (nextInput, nextInit) => invokeAt(index + 1, nextInput, nextInit);

        try {
            return Promise.resolve(entry.handler(currentInput, currentInit, nextFetch, invokeTarget));
        } catch (syncError) {
            return Promise.reject(syncError);
        }
    };

    return invokeAt(0, input, init);
}

function createDispatcher(state, capturedUnderlyingFetch) {
    const dispatcherFetch = function baiBaiToolkitFetchDispatcher(input, init) {
        if (dispatcherFetch.__baiBaiToolkitRetired) {
            return invokePromiseSafe(capturedUnderlyingFetch, this ?? globalThis, input, init);
        }
        return dispatchFetchPipeline(state, this, input, init, capturedUnderlyingFetch);
    };

    dispatcherFetch.__baiBaiToolkitFetchDispatcher = true;
    dispatcherFetch.__baiBaiToolkitUnderlyingFetch = capturedUnderlyingFetch;
    dispatcherFetch.__baiBaiToolkitRetired = false;
    return dispatcherFetch;
}

function isActiveDispatcherReachable(state) {
    const activeDispatcher = state?.dispatcherFetch;
    if (typeof activeDispatcher !== 'function' || activeDispatcher.__baiBaiToolkitRetired) {
        return false;
    }
    if (typeof globalThis.fetch !== 'function') {
        return false;
    }
    return globalThis.fetch !== activeDispatcher.__baiBaiToolkitUnderlyingFetch;
}

function ensureDispatcherMounted(state, wasEmpty) {
    if (typeof globalThis.fetch !== 'function') {
        return false;
    }

    const activeDispatcher = state.dispatcherFetch;
    if (typeof activeDispatcher === 'function' && !activeDispatcher.__baiBaiToolkitRetired) {
        const underlying = activeDispatcher.__baiBaiToolkitUnderlyingFetch;
        if (
            globalThis.fetch === activeDispatcher
            || (!wasEmpty && globalThis.fetch !== underlying)
            || (wasEmpty && state.pinnedAboveFetch && globalThis.fetch === state.pinnedAboveFetch)
        ) {
            return true;
        }

        activeDispatcher.__baiBaiToolkitRetired = true;
        state.dispatcherFetch = null;
        state.pinnedAboveFetch = null;
    }

    const capturedUnderlyingFetch = globalThis.fetch;
    const dispatcherFetch = createDispatcher(state, capturedUnderlyingFetch);
    state.dispatcherFetch = dispatcherFetch;
    state.pinnedAboveFetch = null;
    globalThis.fetch = dispatcherFetch;
    return true;
}

function unmountDispatcherIfEmpty(state) {
    if (state.slots.size > 0 || !state.dispatcherFetch) {
        return false;
    }

    const activeDispatcher = state.dispatcherFetch;
    if (globalThis.fetch === activeDispatcher) {
        globalThis.fetch = activeDispatcher.__baiBaiToolkitUnderlyingFetch;
        activeDispatcher.__baiBaiToolkitRetired = true;
        state.dispatcherFetch = null;
        state.pinnedAboveFetch = null;
        return true;
    }

    state.pinnedAboveFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
    return false;
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
    const wasEmpty = state.slots.size === 0;
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
    return ensureDispatcherMounted(state, wasEmpty);
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
    return isActiveDispatcherReachable(state);
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
    const underlying = isActiveDispatcherReachable(state)
        ? state.dispatcherFetch.__baiBaiToolkitUnderlyingFetch
        : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

    return invokePromiseSafe(underlying, thisArg ?? globalThis, input, init);
}

function resetFetchPipeline() {
    const state = globalThis[FETCH_PIPELINE_KEY];
    if (!state || !(state.slots instanceof Map)) {
        return false;
    }
    state.slots.clear();
    state.sortedEntries = [];
    const unmounted = unmountDispatcherIfEmpty(state);
    if (state.dispatcherFetch) {
        state.dispatcherFetch.__baiBaiToolkitRetired = true;
        state.dispatcherFetch = null;
    }
    state.pinnedAboveFetch = null;
    return unmounted;
}

export {
    FETCH_PIPELINE_KEY,
    FETCH_PIPELINE_SLOT_ORDER,
    callUnderlyingFetch,
    getActiveFetchPipelineSlots,
    hasFetchPipelineSlot,
    registerFetchPipelineSlot,
    resetFetchPipeline,
    unregisterFetchPipelineSlot,
};
