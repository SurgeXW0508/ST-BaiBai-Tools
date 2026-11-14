import { getRequestHeaders } from '@sillytavern/script';
import { hasFetchPipelineSlot, registerFetchPipelineSlot, unregisterFetchPipelineSlot } from '../features/fetchPipeline.js';
import { BAIBAOKU_FAST_CHAT_BACKUPS_LIST_URL, BAIBAOKU_FAST_SEARCH_URL, CHAT_BACKUP_ITEM_INTRINSIC_FALLBACK_PX, CHAT_BACKUP_ITEM_INTRINSIC_SIZE_VAR, CHAT_BACKUP_ITEM_SELECTOR, CHAT_BACKUP_LIST_SELECTOR, CHAT_MANAGEMENT_LIST_SELECTOR, CHAT_MANAGEMENT_POPUP_SELECTOR, FAST_CHAT_BACKUPS_FETCH_KEY, FAST_CHAT_LIST_SCROLL_STYLE_ID, FAST_CHAT_SEARCH_FETCH_KEY, NATIVE_CHAT_BACKUPS_LIST_URL } from './constants.js';
import { LOG_PREFIX, extensionState, settings } from './state.js';

function applyFastChatListScrollOptimization() {
    const existingStyle = document.getElementById(FAST_CHAT_LIST_SCROLL_STYLE_ID);

    if (!settings.chatListScrollOptimizationEnabled) {
        existingStyle?.remove();
        clearChatBackupItemIntrinsicHeightMeasurement();
        observeChatManagementPopupCleanup();
        return;
    }

    if (!existingStyle) {
        const style = document.createElement('style');
        style.id = FAST_CHAT_LIST_SCROLL_STYLE_ID;
        style.textContent = `
${CHAT_MANAGEMENT_POPUP_SELECTOR} ${CHAT_MANAGEMENT_LIST_SELECTOR} > .select_chat_block_wrapper {
    content-visibility: auto;
    contain: layout paint style;
    contain-intrinsic-size: 72px;
}

${CHAT_MANAGEMENT_POPUP_SELECTOR} ${CHAT_BACKUP_LIST_SELECTOR} > ${CHAT_BACKUP_ITEM_SELECTOR} {
    content-visibility: auto;
    contain: layout paint style;
    contain-intrinsic-size: auto var(${CHAT_BACKUP_ITEM_INTRINSIC_SIZE_VAR}, ${CHAT_BACKUP_ITEM_INTRINSIC_FALLBACK_PX}px);
}
`;
        document.head.append(style);
    }

    const popup = document.querySelector(CHAT_MANAGEMENT_POPUP_SELECTOR);
    if (popup) {
        observeChatBackupListIntrinsicHeight(popup);
    }
}

function observeChatBackupListIntrinsicHeight(popup) {
    if (!settings.chatListScrollOptimizationEnabled || !(popup instanceof Element)) {
        return false;
    }

    const list = popup.querySelector(CHAT_BACKUP_LIST_SELECTOR);
    if (list instanceof HTMLElement) {
        extensionState.chatBackupListAttachObserver?.disconnect();
        extensionState.chatBackupListAttachObserver = null;

        if (extensionState.chatBackupListObserverTarget !== list) {
            extensionState.chatBackupListMutationObserver?.disconnect();
            extensionState.chatBackupListResizeObserver?.disconnect();

            extensionState.chatBackupListObserverTarget = list;
            extensionState.chatBackupListMutationObserver = new MutationObserver(() => {
                scheduleChatBackupItemIntrinsicHeightMeasurement(popup);
            });
            extensionState.chatBackupListMutationObserver.observe(list, {
                childList: true,
            });

            extensionState.chatBackupListResizeObserver = typeof ResizeObserver === 'function'
                ? new ResizeObserver(() => {
                    scheduleChatBackupItemIntrinsicHeightMeasurement(popup);
                })
                : null;
            extensionState.chatBackupListResizeObserver?.observe(list);
        }

        scheduleChatBackupItemIntrinsicHeightMeasurement(popup);
        return true;
    }

    if (extensionState.chatBackupListAttachObserver) {
        return false;
    }

    const attachObserver = new MutationObserver(() => {
        if (observeChatBackupListIntrinsicHeight(popup)) {
            attachObserver.disconnect();
            if (extensionState.chatBackupListAttachObserver === attachObserver) {
                extensionState.chatBackupListAttachObserver = null;
            }
        }
    });
    attachObserver.observe(popup, {
        childList: true,
        subtree: true,
    });
    extensionState.chatBackupListAttachObserver = attachObserver;
    return false;
}

function scheduleChatBackupItemIntrinsicHeightMeasurement(popup) {
    if (!settings.chatListScrollOptimizationEnabled || !(popup instanceof Element)) {
        return;
    }

    if (extensionState.chatBackupItemMeasureFrame !== undefined
        && extensionState.chatBackupItemMeasureFrame !== null) {
        return;
    }

    extensionState.chatBackupItemMeasureFrame = requestAnimationFrame(() => {
        extensionState.chatBackupItemMeasureFrame = null;
        measureChatBackupItemIntrinsicHeight(popup);
    });
}

function measureChatBackupItemIntrinsicHeight(popup) {
    const list = popup.querySelector(CHAT_BACKUP_LIST_SELECTOR);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    if (!list.classList.contains('open')) {
        return;
    }

    const listRect = list.getBoundingClientRect();
    const item = list.firstElementChild;

    if (!(item instanceof HTMLElement) || !item.matches(CHAT_BACKUP_ITEM_SELECTOR)) {
        return;
    }

    const itemRect = item.getBoundingClientRect();
    if (itemRect.height <= 0 || itemRect.bottom <= listRect.top || itemRect.top >= listRect.bottom) {
        return;
    }

    const measuredHeight = Math.ceil(itemRect.height);
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
        return;
    }

    const previousHeight = Number(list.dataset.baiBaiToolkitBackupItemHeight || 0);
    if (previousHeight === measuredHeight) {
        return;
    }

    list.dataset.baiBaiToolkitBackupItemHeight = String(measuredHeight);
    list.style.setProperty(CHAT_BACKUP_ITEM_INTRINSIC_SIZE_VAR, `${measuredHeight}px`);
}

function clearChatBackupItemIntrinsicHeightMeasurement() {
    if (extensionState.chatBackupItemMeasureFrame !== undefined
        && extensionState.chatBackupItemMeasureFrame !== null) {
        cancelAnimationFrame(extensionState.chatBackupItemMeasureFrame);
    }

    extensionState.chatBackupItemMeasureFrame = null;
    extensionState.chatBackupListAttachObserver?.disconnect();
    extensionState.chatBackupListAttachObserver = null;
    extensionState.chatBackupListMutationObserver?.disconnect();
    extensionState.chatBackupListMutationObserver = null;
    extensionState.chatBackupListResizeObserver?.disconnect();
    extensionState.chatBackupListResizeObserver = null;
    extensionState.chatBackupListObserverTarget = null;
}

function observeChatManagementPopupCleanup() {
    if (!settings.chatListAutoClearEnabled && !settings.chatListScrollOptimizationEnabled) {
        extensionState.chatManagementPopupObserver?.disconnect();
        extensionState.chatManagementPopupObserver = null;
        clearChatBackupItemIntrinsicHeightMeasurement();
        return false;
    }

    const popup = document.querySelector(CHAT_MANAGEMENT_POPUP_SELECTOR);
    if (extensionState.chatManagementPopupObserver) {
        if (settings.chatListScrollOptimizationEnabled && popup) {
            observeChatBackupListIntrinsicHeight(popup);
        }
        return true;
    }

    if (!popup) {
        return false;
    }

    let wasVisible = isElementDisplayed(popup);
    const observer = new MutationObserver(() => {
        const isVisible = isElementDisplayed(popup);

        if (wasVisible && !isVisible) {
            clearChatManagementPopupContent(popup);
        }

        if (!wasVisible && isVisible) {
            scheduleChatBackupItemIntrinsicHeightMeasurement(popup);
        }
        wasVisible = isVisible;
    });

    observer.observe(popup, {
        attributes: true,
        attributeFilter: ['style', 'class'],
    });

    if (settings.chatListScrollOptimizationEnabled) {
        observeChatBackupListIntrinsicHeight(popup);
    }
    extensionState.chatManagementPopupObserver = observer;
    return true;
}

function isElementDisplayed(element) {
    return getComputedStyle(element).display !== 'none';
}

function clearChatManagementPopupContent(popup) {
    if (!settings.chatListAutoClearEnabled) {
        return;
    }

    const list = popup.querySelector(CHAT_MANAGEMENT_LIST_SELECTOR);

    if (!list || !list.children.length) {
        return;
    }

    list.replaceChildren();
}

function patchFastChatSearchFetch() {
    if (typeof globalThis.fetch !== 'function') {
        return null;
    }

    const existing = globalThis[FAST_CHAT_SEARCH_FETCH_KEY];
    if (existing && hasFetchPipelineSlot('fastChatSearch')) {
        existing.disabled = false;
        return existing;
    }

    const state = existing && typeof existing === 'object'
        ? existing
        : { disabled: false };

    state.disabled = false;

    registerFetchPipelineSlot('fastChatSearch', async function baiBaiToolkitFetch(input, init, nextFetch) {
        if (state.disabled || !settings.fastChatListEnabled) {
            return nextFetch(input, init);
        }

        const requestData = await getFastChatSearchRequestData(input, init);

        if (requestData) {
            try {
                return await fetchFastSearchList(nextFetch, requestData);
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw error;
                }
                console.debug(`${LOG_PREFIX} Backend fast-search path failed; falling back to /api/chats/search`, error);
            }
        }

        return nextFetch(input, init);
    });

    globalThis[FAST_CHAT_SEARCH_FETCH_KEY] = state;
    return state;
}

function unpatchFastChatSearchFetch() {
    const existing = globalThis[FAST_CHAT_SEARCH_FETCH_KEY];
    if (existing && typeof existing === 'object') {
        existing.disabled = true;
    }
    const removed = unregisterFetchPipelineSlot('fastChatSearch');
    delete globalThis[FAST_CHAT_SEARCH_FETCH_KEY];
    return removed;
}

function patchFastChatBackupsFetch() {
    if (typeof globalThis.fetch !== 'function') {
        return null;
    }

    const existing = globalThis[FAST_CHAT_BACKUPS_FETCH_KEY];
    if (existing && hasFetchPipelineSlot('fastChatBackups')) {
        existing.disabled = false;
        return existing;
    }

    const state = existing && typeof existing === 'object'
        ? existing
        : { disabled: false };

    state.disabled = false;

    registerFetchPipelineSlot('fastChatBackups', async function baiBaiToolkitChatBackupsFetch(input, init, nextFetch) {
        if (state.disabled || !settings.fastChatListEnabled) {
            return nextFetch(input, init);
        }

        if (isChatBackupsListRequest(input, init)) {
            observeChatManagementPopupCleanup();
            try {
                return await fetchFastChatBackupsList(nextFetch, input, init);
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw error;
                }
                console.debug(`${LOG_PREFIX} Fast chat backup list failed; falling back to native endpoint`, error);
            }
        }

        return nextFetch(input, init);
    });

    globalThis[FAST_CHAT_BACKUPS_FETCH_KEY] = state;
    return state;
}

function unpatchFastChatBackupsFetch() {
    const existing = globalThis[FAST_CHAT_BACKUPS_FETCH_KEY];
    if (existing && typeof existing === 'object') {
        existing.disabled = true;
    }
    const removed = unregisterFetchPipelineSlot('fastChatBackups');
    delete globalThis[FAST_CHAT_BACKUPS_FETCH_KEY];
    return removed;
}

function applyFastChatListFetchOptimization() {
    if (settings.fastChatListEnabled) {
        patchFastChatSearchFetch();
        patchFastChatBackupsFetch();
    } else {
        unpatchFastChatBackupsFetch();
        unpatchFastChatSearchFetch();
    }
}

function isChatBackupsListRequest(input, init) {
    try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(rawUrl, location.origin);
        const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        return method === 'POST'
            && url.origin === location.origin
            && url.pathname === NATIVE_CHAT_BACKUPS_LIST_URL;
    } catch {
        return false;
    }
}

async function fetchFastChatBackupsList(fetchFn, input, init) {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await fetchFn(BAIBAOKU_FAST_CHAT_BACKUPS_LIST_URL, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        signal,
    });

    if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`);
    }

    return response;
}

async function getFastChatSearchRequestData(input, init) {
    if (!settings.fastChatListEnabled) {
        return null;
    }

    if (!isChatSearchUrl(input)) {
        return null;
    }

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (method !== 'POST') {
        return null;
    }

    const body = await readJsonRequestBody(input, init);

    if (!body || typeof body !== 'object') {
        return null;
    }

    const query = String(body.query ?? '');
    const avatarUrl = body.avatar_url;
    const groupId = body.group_id;

    if (query.trim().length !== 0) {
        return null;
    }

    const hasAvatar = typeof avatarUrl === 'string' && avatarUrl.length > 0;
    const hasGroup = typeof groupId === 'string' && groupId.length > 0;

    if (!hasAvatar && !hasGroup) {
        return null;
    }

    return {
        avatarUrl: hasAvatar ? avatarUrl : undefined,
        groupId: hasGroup ? groupId : undefined,
    };
}

function isChatSearchUrl(input) {
    try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(rawUrl, location.origin);
        return url.origin === location.origin && url.pathname === '/api/chats/search';
    } catch {
        return false;
    }
}

async function readJsonRequestBody(input, init) {
    const initBody = init?.body;

    if (typeof initBody === 'string') {
        return tryParseJson(initBody);
    }

    if (input instanceof Request) {
        try {
            return await input.clone().json().catch(() => null);
        } catch {
            return null;
        }
    }

    return null;
}

async function fetchFastSearchList(fetchFn, { avatarUrl, groupId }) {
    const requestBody = { query: '' };

    if (groupId) {
        requestBody.group_id = groupId;
    } else {
        requestBody.avatar_url = avatarUrl;
    }

    const response = await fetchFn(BAIBAOKU_FAST_SEARCH_URL, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`);
    }

    const results = await response.json();

    if (!Array.isArray(results)) {
        throw new Error('fast-search returned a non-array payload');
    }

    // Backend fast-search returns the complete payload in one shot, matching ST's
    // /api/chats/search response shape, so no placeholder/hydrate pass is needed.
    // ST sorts the results itself (see script.js search consumer), so return as-is.
    return new Response(JSON.stringify(results), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

function tryParseJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export {
    applyFastChatListFetchOptimization,
    applyFastChatListScrollOptimization,
    clearChatBackupItemIntrinsicHeightMeasurement,
    clearChatManagementPopupContent,
    fetchFastChatBackupsList,
    fetchFastSearchList,
    getFastChatSearchRequestData,
    isChatBackupsListRequest,
    isChatSearchUrl,
    isElementDisplayed,
    measureChatBackupItemIntrinsicHeight,
    observeChatBackupListIntrinsicHeight,
    observeChatManagementPopupCleanup,
    patchFastChatBackupsFetch,
    patchFastChatSearchFetch,
    readJsonRequestBody,
    scheduleChatBackupItemIntrinsicHeightMeasurement,
    tryParseJson,
    unpatchFastChatBackupsFetch,
    unpatchFastChatSearchFetch,
};
