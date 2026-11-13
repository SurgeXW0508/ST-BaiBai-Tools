const SCROLL_TOP_PATCH_STATE_KEY = '__baiBaiToolkitScrollTopPatchState';

function findScrollTopDescriptorTarget(preferredPrototype = null) {
    const candidates = [
        preferredPrototype,
        globalThis.Element?.prototype,
        globalThis.HTMLElement?.prototype,
    ].filter(Boolean);

    const seen = new Set();
    for (const prototype of candidates) {
        if (seen.has(prototype)) {
            continue;
        }
        seen.add(prototype);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop');
        if (descriptor?.get && descriptor?.set) {
            return { prototype, descriptor };
        }
    }

    return null;
}

function ensureScrollTopPatch(preferredPrototype = null) {
    const target = findScrollTopDescriptorTarget(preferredPrototype);
    if (!target) {
        return null;
    }

    const { prototype, descriptor } = target;
    const existing = descriptor.set?.[SCROLL_TOP_PATCH_STATE_KEY];
    if (existing) {
        return existing;
    }

    const originalSet = descriptor.set;
    const interceptors = new Map();

    const rebuildOrdered = () => [...interceptors.values()].sort((a, b) => a.priority - b.priority);
    let ordered = [];

    function guardedScrollTopSetter(value) {
        for (let i = 0; i < ordered.length; i++) {
            let handled = false;
            try {
                handled = ordered[i].handler(this, value, originalSet) === true;
            } catch (error) {
                console.debug(`[BaiBaiToolkit] scrollTop interceptor "${ordered[i].id}" failed`, error);
            }
            if (handled) {
                return;
            }
        }
        return originalSet.call(this, value);
    }

    const patchState = {
        prototype,
        originalGet: descriptor.get,
        originalSet,
        setter: guardedScrollTopSetter,
        register(id, handler, { priority = 0, flagKey = '' } = {}) {
            if (typeof handler !== 'function') {
                return patchState;
            }
            interceptors.set(id, { id, handler, priority });
            ordered = rebuildOrdered();
            if (flagKey) {
                guardedScrollTopSetter[flagKey] = true;
            }
            return patchState;
        },
    };

    guardedScrollTopSetter[SCROLL_TOP_PATCH_STATE_KEY] = patchState;
    guardedScrollTopSetter.__baiBaiToolkitOriginalScrollTopSetter = originalSet;

    Object.defineProperty(prototype, 'scrollTop', {
        ...descriptor,
        set: guardedScrollTopSetter,
    });

    return patchState;
}

function registerScrollTopWriteInterceptor(id, handler, options = {}) {
    const patchState = ensureScrollTopPatch(options.prototype ?? null);
    if (!patchState) {
        return null;
    }
    return patchState.register(id, handler, options);
}

export {
    SCROLL_TOP_PATCH_STATE_KEY,
    ensureScrollTopPatch,
    registerScrollTopWriteInterceptor,
};
