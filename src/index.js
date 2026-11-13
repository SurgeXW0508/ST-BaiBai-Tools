// 柏宝箱入口:模块装配与顶层接线(由原 index.js 拆分而来,功能实现在 features/ 下)
import * as chatOptimizations from './chat/index.js';
import * as presetOptimizations from './preset/index.js';
import * as worldInfoPageOptimization from './worldinfo/index.js';
import { configureFloorManager, installFloorManager } from './floorManager.js';
import { DESCRIPTION_CODEMIRROR_HISTORY_MAX_LENGTH, LOG_PREFIX } from './features/constants.js';
import { loadDescriptionCodeMirrorModules } from './features/descEditor.js';
import { installExtensionOpsFetchHook } from './features/extensionOps.js';
import { installGenerateBlacklistRetry } from './features/generateBlacklistRetry.js';
import { syncGenerateRetryFetchHook } from './features/generateRetry.js';
import { installGenerationLifecycle } from './features/generationLifecycle.js';
import { installPageRestoreSelectionGuard } from './features/globalGuards.js';
import { syncSaveRequestGzipFetchHook } from './features/gzipHook.js';
import { recordPerformanceTraceLongDomRefresh, syncPerformanceTraceFetchHook } from './features/perfTrace.js';
import { installReloadGreetingGuard } from './features/reloadGuard.js';
import { applyFeatureSettings, renderSettingsPanel } from './features/settingsPanel.js';
import { extensionState, initializeSettings, saveExtensionSettings, settings } from './features/state.js';
import { initializeExtensionUpdateCheck } from './features/updateCheck.js';
import { installExtensionUpdateDiagnosticsFetchHook } from './features/updateDiagnostics.js';

chatOptimizations.configureChatOptimizations({
    settings,
    extensionState,
    logPrefix: LOG_PREFIX,
    recordLongDomRefresh: recordPerformanceTraceLongDomRefresh,
});
presetOptimizations.configurePresetOptimizations({
    settings,
    extensionState,
    logPrefix: LOG_PREFIX,
    loadCodeMirrorModules: loadDescriptionCodeMirrorModules,
    codeMirrorHistoryMaxLength: DESCRIPTION_CODEMIRROR_HISTORY_MAX_LENGTH,
    saveSettings: saveExtensionSettings,
});
worldInfoPageOptimization.configureWorldInfoPageOptimization({
    settings,
    extensionState,
    logPrefix: LOG_PREFIX,
    saveSettings: saveExtensionSettings,
});
presetOptimizations.installOpenAITokenizerBulkBridge();
configureFloorManager({
    settings,
    extensionState,
    logPrefix: LOG_PREFIX,
    saveSettings: saveExtensionSettings,
});

initializeSettings();
initializeExtensionUpdateCheck();

if (!extensionState.installed) {
    extensionState.installed = true;
    console.debug(`${LOG_PREFIX} Installed`);
}

chatOptimizations.applyFastChatListFetchOptimization();
syncSaveRequestGzipFetchHook();
syncPerformanceTraceFetchHook();
// 先生命周期、后重试:停止信号要先于重试模块的监听器更新。
installGenerationLifecycle();
// Personal Stable does not assemble Save Generate. Generate Retry keeps its native path.
syncGenerateRetryFetchHook();
installGenerateBlacklistRetry();
installExtensionUpdateDiagnosticsFetchHook();
// 必须包在诊断钩子外层:任务 id 头要加在请求上,诊断钩子再按响应里的柏宝库标记跳过。
installExtensionOpsFetchHook();
installReloadGreetingGuard();
installPageRestoreSelectionGuard();
chatOptimizations.observeChatManagementPopupCleanup();
applyFeatureSettings();
jQuery(renderSettingsPanel);
jQuery(installFloorManager);
