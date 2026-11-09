import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the actual settings lifecycle without a live ST account or saved chats.
for (const initial of [undefined, false, true]) for (const migrated of [false, true]) {
    test(`Save Generate stays off across legacy settings and reinitialization: enabled=${initial}, migrated=${migrated}`, async () => {
        const stored = { saveGenerateEnabled: initial, saveGenerateDefaultEnabledMigrated: migrated, generateRetryEnabled: true };
        const extension_settings = { baiBaiToolkit: stored };
        let saves = 0;
        const context = vm.createContext({ URL, console });
        const module = new vm.SourceTextModule(await readFile(new URL('../src/features/state.js', import.meta.url), 'utf8'), {
            context, initializeImportMeta: meta => { meta.url = 'https://isolated.invalid/scripts/extensions/third-party/ST-BaiBai-Tools/dist/index.js'; },
        });
        await module.link(source => {
            const values = source === '@sillytavern/script' ? { saveSettingsDebounced: () => saves++ }
                : source === '@sillytavern/scripts/extensions' ? { extension_settings }
                    : { EXTENSION_KEY: '__personalStableTest', SETTINGS_KEY: 'baiBaiToolkit' };
            return new vm.SyntheticModule(Object.keys(values), function () {
                for (const [key, value] of Object.entries(values)) this.setExport(key, value);
            }, { context });
        });
        await module.evaluate();
        const state = module.namespace;
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
