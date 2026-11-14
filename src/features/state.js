import { saveSettingsDebounced } from '@sillytavern/script';
import { extension_settings } from '@sillytavern/scripts/extensions';
import { BAIBAOKU_EARLY_BRIDGE_KEY, EXTENSION_KEY, SETTINGS_KEY } from './constants.js';
const MODULE_NAME = getModuleName();
const EXTENSION_ID = getExtensionId();
const defaultSettings = {
    updatePromptOnAvailableEnabled: true,
    resizeGuardEnabled: true,
    descriptionCodeMirrorEditorEnabled: false,
    customCssInputOptimizationEnabled: true,
    customCssShadowPropertyEnabled: true,
    worldInfoDrawerOptimizationEnabled: true,
    worldInfoPageOptimizationEnabled: true,
    worldInfoListOptimizationEnabled: true,
    worldInfoSearchReplaceEnabled: true,
    characterSearchInputOptimizationEnabled: true,
    baibaokuSettingsAccelerationEnabled: true,
    baibaokuLazyThemeLoadingEnabled: true,
    fastCharacterListEnabled: true,
    recentChatListAccelerationEnabled: true,
    progressiveChatLoadingEnabled: false,
    saveGenerateEnabled: false,
    tokenizerBulkCountEnabled: true,
    chatKeyboardScanReductionEnabled: false,
    extensionManifestBundleEnabled: true,
    presetAutoBackupEnabled: true,
    presetBackupAutoCleanupEnabled: true,
    presetBackupKeepCount: 200,
    characterListAvatarLazyLoadEnabled: true,
    fastChatListEnabled: true,
    welcomeRecentChatDirectOpenEnabled: true,
    saveRequestGzipEnabled: true,
    translateMessageUpdatedOptimizationEnabled: true,
    longChatDomRenderOptimizationEnabled: true,
    streamingRegexDeferEnabled: true,
    reduceLoadedFloorsEnabled: true,
    messageCompletionScrollToMiddleEnabled: true,
    chatListScrollOptimizationEnabled: true,
    chatListAutoClearEnabled: true,
    chatLossMitigationEnabled: true,
    mobileAutoKeyboardSuppressionEnabled: true,
    mobileMessageEditScrollGuardEnabled: true,
    presetScrollOptimizationEnabled: true,
    presetDragOptimizationEnabled: true,
    presetVueDragLocked: false,
    presetMobileWholeRowDragEnabled: true,
    presetSwitchOptimizationEnabled: true,
    presetToggleOptimizationEnabled: true,
    presetGroupingEnabled: true,
    presetGroupingEditButtonInMenuEnabled: false,
    presetInterfaceCollapseEnabled: true,
    presetPromptCodeMirrorEditorEnabled: false,
    presetAutoSaveAfterPromptEditEnabled: false,
    regexQuickOperationOptimizationEnabled: true,
    regexListGroups: {},
    chatDeleteEditFlowOptimizationEnabled: true,
    messageEditBottomActionsEnabled: true,
    newFloorManagerEnabled: true,
    messageDoubleClickEditEnabled: false,
    messageTripleClickEditEnabled: true,
    messageCompletionSoundEnabled: false,
    messageCompletionSoundSource: 'builtin',
    messageCompletionSoundBuiltinId: 'guoke-bell',
    messageCompletionSoundUrl: '',
    messageCompletionSoundVolume: 0.8,
    messageCompletionSoundLocalFileName: '',
    messageCompletionSoundKeepAliveEnabled: true,
    generateRetryEnabled: false,
    generateRetryMaxRetries: 3,
    generateBlacklistRetryEnabled: false,
    generateBlacklistRetryText: '',
};
const linkedPresetOptimizationSettingKeys = [
    'presetScrollOptimizationEnabled',
    'presetDragOptimizationEnabled',
    'presetMobileWholeRowDragEnabled',
    'presetToggleOptimizationEnabled',
];
const baibaokuOwnedSettingKeys = new Set([
    'baibaokuSettingsAccelerationEnabled',
    'baibaokuLazyThemeLoadingEnabled',
    'fastCharacterListEnabled',
    'recentChatListAccelerationEnabled',
    'progressiveChatLoadingEnabled',
    'extensionManifestBundleEnabled',
    'tokenizerBulkCountEnabled',
    'chatKeyboardScanReductionEnabled',
]);
const legacySettingsKeys = [
    'generateBlacklistRetryMaxRetries',
    'textareaScrollOptimizationEnabled',
    'descriptionShadowEditorEnabled',
    'descriptionInputBubbleOptimizationEnabled',
    'descriptionInputIdleSaveEnabled',
    'imeCommitOptimizationEnabled',
    'mobileChatEntryKeyboardSuppressionEnabled',
    'fastSettingsBootstrapEnabled',
    'fastCharacterListEnabled',
    'tokenizerBulkCountEnabled',
    'chatKeyboardScanReductionEnabled',
];
const settings = { ...defaultSettings };
const extensionState = getExtensionState();

function getExtensionState() {
    if (!globalThis[EXTENSION_KEY] || typeof globalThis[EXTENSION_KEY] !== 'object') {
        globalThis[EXTENSION_KEY] = {};
    }

    return globalThis[EXTENSION_KEY];
}

function getModuleName() {
    const extensionPathMarker = '/scripts/extensions/';
    const currentUrl = new URL(import.meta.url);
    const currentPath = decodeURIComponent(currentUrl.pathname.replace(/\\/g, '/'));
    const markerIndex = currentPath.indexOf(extensionPathMarker);

    if (markerIndex === -1) {
        return 'third-party/SillyTavern-Mobile-Resize-Guard';
    }

    return currentPath
        .slice(markerIndex + extensionPathMarker.length)
        .replace(/\/(?:dist\/)?index\.js$/i, '');
}

function getExtensionId() {
    return MODULE_NAME.split('/').pop() || MODULE_NAME;
}

function readBridgeFlag(bridge, methodName, propName) {
    if (!bridge || typeof bridge !== 'object') {
        return null;
    }
    if (typeof bridge[methodName] === 'function') {
        try {
            const value = bridge[methodName]();
            if (typeof value === 'boolean') {
                return value;
            }
        } catch {
            // Fall back to plain bridge properties if getter fails.
        }
    }
    if (typeof bridge[propName] === 'boolean') {
        return bridge[propName];
    }
    if (typeof bridge.config?.[propName] === 'boolean') {
        return bridge.config[propName];
    }
    if (typeof bridge.fastConfig?.[propName] === 'boolean') {
        return bridge.fastConfig[propName];
    }
    if (typeof bridge.initialFastConfig?.[propName] === 'boolean') {
        return bridge.initialFastConfig[propName];
    }
    return null;
}

function hydrateSettingsFromBaibaokuEarlyBridge() {
    settings.progressiveChatLoadingEnabled = false;
    settings.saveGenerateEnabled = false;
    settings.chatKeyboardScanReductionEnabled = false;

    const bridge = globalThis[BAIBAOKU_EARLY_BRIDGE_KEY];
    if (!bridge || typeof bridge !== 'object') {
        return false;
    }

    let hydrated = false;
    const settingsAccel = readBridgeFlag(bridge, 'isSettingsAccelerationEnabled', 'settingsAccelerationEnabled');
    if (typeof settingsAccel === 'boolean') {
        settings.baibaokuSettingsAccelerationEnabled = settingsAccel;
        hydrated = true;
    }

    const lazyTheme = readBridgeFlag(bridge, 'isLazyThemeLoadingEnabled', 'lazyThemeLoadingEnabled');
    if (typeof lazyTheme === 'boolean') {
        settings.baibaokuLazyThemeLoadingEnabled = settings.baibaokuSettingsAccelerationEnabled !== false && lazyTheme;
        hydrated = true;
    } else if (settings.baibaokuSettingsAccelerationEnabled === false) {
        settings.baibaokuLazyThemeLoadingEnabled = false;
    }

    const manifestBundle = readBridgeFlag(bridge, 'isExtensionManifestBundleEnabled', 'extensionManifestBundleEnabled');
    if (typeof manifestBundle === 'boolean') {
        settings.extensionManifestBundleEnabled = manifestBundle;
        hydrated = true;
    }

    const characterList = readBridgeFlag(bridge, 'isCharacterListAccelerationEnabled', 'characterListAccelerationEnabled');
    if (typeof characterList === 'boolean') {
        settings.fastCharacterListEnabled = characterList;
        hydrated = true;
    }

    const recentChatList = readBridgeFlag(bridge, 'isRecentChatListAccelerationEnabled', 'recentChatListAccelerationEnabled');
    if (typeof recentChatList === 'boolean') {
        settings.recentChatListAccelerationEnabled = recentChatList;
        hydrated = true;
    }

    const tokenizerBulk = readBridgeFlag(bridge, 'isTokenizerBulkCountEnabled', 'tokenizerBulkCountEnabled');
    if (typeof tokenizerBulk === 'boolean') {
        settings.tokenizerBulkCountEnabled = tokenizerBulk;
        hydrated = true;
    }

    return hydrated;
}

function initializeSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }

    let removedLegacySetting = false;
    let migratedSettingsAcceleration = undefined;

    if (
        typeof extension_settings[SETTINGS_KEY].baibaokuSettingsAccelerationEnabled === 'boolean'
    ) {
        migratedSettingsAcceleration = extension_settings[SETTINGS_KEY].baibaokuSettingsAccelerationEnabled;
        delete extension_settings[SETTINGS_KEY].baibaokuSettingsAccelerationEnabled;
        removedLegacySetting = true;
    } else if (
        typeof extension_settings[SETTINGS_KEY].fastSettingsBootstrapEnabled === 'boolean'
    ) {
        migratedSettingsAcceleration = extension_settings[SETTINGS_KEY].fastSettingsBootstrapEnabled;
    }

    for (const key of baibaokuOwnedSettingKeys) {
        if (Object.prototype.hasOwnProperty.call(extension_settings[SETTINGS_KEY], key)) {
            delete extension_settings[SETTINGS_KEY][key];
            removedLegacySetting = true;
        }
    }

    for (const key of legacySettingsKeys) {
        if (Object.prototype.hasOwnProperty.call(extension_settings[SETTINGS_KEY], key)) {
            delete extension_settings[SETTINGS_KEY][key];
            removedLegacySetting = true;
        }
    }

    // Personal Stable never arms Save Generate, including previously enabled settings.
    if (extension_settings[SETTINGS_KEY].saveGenerateEnabled !== false) {
        extension_settings[SETTINGS_KEY].saveGenerateEnabled = false;
        removedLegacySetting = true;
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (baibaokuOwnedSettingKeys.has(key)) {
            continue;
        }
        if (typeof extension_settings[SETTINGS_KEY][key] !== typeof value) {
            extension_settings[SETTINGS_KEY][key] = value;
        }
    }

    Object.assign(settings, defaultSettings, extension_settings[SETTINGS_KEY]);
    if (typeof migratedSettingsAcceleration === 'boolean') {
        settings.baibaokuSettingsAccelerationEnabled = migratedSettingsAcceleration;
    }
    hydrateSettingsFromBaibaokuEarlyBridge();
    const normalizedPresetLinkedOptimizationSettings = normalizeLinkedPresetOptimizationSettings();
    const normalizedMessageEditClickSetting = normalizeMessageEditClickSettings();

    if (
        removedLegacySetting
        || normalizedPresetLinkedOptimizationSettings
        || normalizedMessageEditClickSetting
    ) {
        saveSettingsDebounced();
    }
}

function normalizeMessageEditClickSettings() {
    if (settings.messageDoubleClickEditEnabled && settings.messageTripleClickEditEnabled) {
        settings.messageDoubleClickEditEnabled = false;
        extension_settings[SETTINGS_KEY].messageDoubleClickEditEnabled = false;
        return true;
    }

    return false;
}

function normalizeLinkedPresetOptimizationSettings() {
    const enabled = linkedPresetOptimizationSettingKeys.some(key => settings[key] === true);
    let changed = false;

    for (const key of linkedPresetOptimizationSettingKeys) {
        if (settings[key] !== enabled) {
            settings[key] = enabled;
            extension_settings[SETTINGS_KEY][key] = enabled;
            changed = true;
        }
    }

    return changed;
}

function saveExtensionSettings() {
    const persistedSettings = { ...settings };
    for (const key of baibaokuOwnedSettingKeys) {
        delete persistedSettings[key];
    }
    Object.assign(extension_settings[SETTINGS_KEY], persistedSettings);
    for (const key of baibaokuOwnedSettingKeys) {
        delete extension_settings[SETTINGS_KEY][key];
    }
    saveSettingsDebounced();
}

export {
    EXTENSION_ID,
    MODULE_NAME,
    baibaokuOwnedSettingKeys,
    defaultSettings,
    extensionState,
    getExtensionId,
    getExtensionState,
    getModuleName,
    hydrateSettingsFromBaibaokuEarlyBridge,
    initializeSettings,
    legacySettingsKeys,
    linkedPresetOptimizationSettingKeys,
    normalizeLinkedPresetOptimizationSettings,
    normalizeMessageEditClickSettings,
    saveExtensionSettings,
    settings,
};
