import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function fixture(app) {
  const root = fileURLToPath(new URL(`../../../vega-${app}/src/lib/`, import.meta.url));
  const values = new Map();
  const mainStorage = {
    getArray: key => values.has(key) ? structuredClone(values.get(key)) : undefined,
    setArray: (key, value) => values.set(key, structuredClone(value)),
    getString: key => values.get(key),
    getNumber: key => values.get(key),
    setNumber: (key, value) => values.set(key, value),
    contains: key => values.has(key),
    delete: key => values.delete(key),
  };
  const mocks = new Map([
    [resolve(root, "storage/StorageService.ts"), { mainStorage }],
    [resolve(root, "storage/sourceTokenStorage.ts"), {
      sourceTokenStorage: { has: () => false, delete: () => {} },
      getSourceAuthHeaders: () => ({}),
    }],
    [resolve(root, "providers/tauriAxiosAdapter.ts"), { tauriAxiosAdapter: () => {} }],
    [resolve(root, "storage.ts"), { settingsStorage: {} }],
    [resolve(root, "services/Notification.ts"), { notificationService: {} }],
    [resolve(root, "zustand/toastStore.ts"), { toast: () => {} }],
    [resolve(root, "zustand/contentStore.ts"), { default: {} }],
    ["axios", { default: {} }],
  ]);
  const modules = new Map();
  function load(filename) {
    if (mocks.has(filename)) return mocks.get(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const execute = runInThisContext(`(function(require, module, exports) {\n${outputText}\n})`, { filename });
    execute(specifier => load(specifier.startsWith(".")
      ? resolve(dirname(filename), `${specifier}.ts`)
      : specifier), module, module.exports);
    return module.exports;
  }
  const { extensionStorage } = load(resolve(root, "storage/extensionStorage.ts"));
  const { extensionManager } = load(resolve(root, "services/ExtensionManager.ts"));
  const { updateProvidersService } = load(resolve(root, "services/UpdateProviders.ts"));
  extensionManager.fetchManifest = async () => [];
  return { extensionStorage, extensionManager, updateProvidersService };
}

const source = { author: "zendax@cb", url: "https://codeberg.org/zendax/vega-providers/raw/branch/main" };
const provider = {
  value: "vega", display_name: "Vega", source, version: "1.0.0",
  icon: "", type: "global", installed: true, disabled: false,
};
const update = { ...provider, version: "2.0.0" };
const module = { value: provider.value, sourceAuthor: source.author, version: update.version, modules: {}, cachedAt: 1 };

for (const app of ["desktop", "mobile"]) {
  test(`${app}: a queued update cannot reinstall an already removed provider`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.installProvider(provider);
    extensionStorage.uninstallProvider(provider.value, source.author);
    extensionManager.downloadProviderModules = async () => {
      assert.fail("A deleted provider must not start an update download");
    };
    assert.equal(await updateProvidersService.updateProvider(update), false);
    assert.deepEqual(extensionStorage.getInstalledProviders(), []);
  });

  test(`${app}: uninstall wins over a download already in progress`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.installProvider(provider);
    let finish;
    extensionManager.downloadProviderModules = async () => {
      await new Promise(resolveDownload => { finish = resolveDownload; });
      extensionStorage.cacheProviderModules(module);
      return module;
    };
    const updating = updateProvidersService.updateProvider(update);
    extensionStorage.uninstallProvider(provider.value, source.author);
    finish();
    assert.equal(await updating, false);
    assert.deepEqual(extensionStorage.getInstalledProviders(), []);
    assert.equal(extensionStorage.getProviderModules(provider.value, source.author), undefined);
  });

  test(`${app}: removing a source during an update cannot restore its providers`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.addProviderSources(source.author, source.url);
    extensionStorage.installProvider(provider);
    let finish;
    extensionManager.downloadProviderModules = async () => {
      await new Promise(resolveDownload => { finish = resolveDownload; });
      extensionStorage.cacheProviderModules(module);
      return module;
    };
    const updating = updateProvidersService.updateProvider(update);
    extensionStorage.setInstalledProviders([]);
    extensionStorage.removeProviderSource(source.author);
    finish();
    assert.equal(await updating, false);
    await extensionManager.initialize();
    assert.deepEqual(extensionStorage.getInstalledProviders(), []);
    assert.deepEqual(extensionStorage.getProviderSources(), []);
  });

  test(`${app}: failed updates preserve the installed version`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.installProvider(provider);
    extensionManager.downloadProviderModules = async () => { throw new Error("download failed"); };
    assert.equal(await updateProvidersService.updateProvider(update), false);
    assert.equal(extensionStorage.getInstalledProviders()[0].version, "1.0.0");
  });

  test(`${app}: a provider from another source cannot resurrect the removed source's copy`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.installProvider({ ...provider, source: { author: "other", url: "https://example.com" } });
    extensionManager.downloadProviderModules = async () => {
      assert.fail("The removed source's provider must not be downloaded");
    };
    assert.equal(await updateProvidersService.updateProvider(update), false);
    assert.equal(extensionStorage.getInstalledProviders().length, 1);
    assert.equal(extensionStorage.getInstalledProviders()[0].source.author, "other");
  });

  test(`${app}: successful updates and explicit reinstalls still work`, async () => {
    const { extensionStorage, extensionManager, updateProvidersService } = fixture(app);
    extensionStorage.installProvider(provider);
    extensionManager.downloadProviderModules = async () => module;
    assert.equal(await updateProvidersService.updateProvider(update), true);
    assert.equal(extensionStorage.getInstalledProviders()[0].version, "2.0.0");
    extensionStorage.uninstallProvider(provider.value, source.author);
    await extensionManager.installProvider(provider);
    assert.equal(extensionStorage.isProviderInstalled(provider.value, source.author), true);
  });
}

test("mobile: seed the default source once and respect its later removal", async () => {
  const { extensionStorage, extensionManager } = fixture("mobile");
  await extensionManager.initialize();
  assert.equal(extensionStorage.getProviderSources().length, 1);
  extensionStorage.removeProviderSource(extensionStorage.getProviderSource().author);
  await extensionManager.initialize();
  assert.deepEqual(extensionStorage.getProviderSources(), []);
});
