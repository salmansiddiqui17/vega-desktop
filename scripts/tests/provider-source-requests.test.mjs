import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Load the source and its storage dependencies using the project's compiler.
const modules = new Map();
function loadTypeScript(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const execute = runInThisContext(`(function(require, module, exports) {\n${outputText}\n})`, { filename });
  execute(specifier => loadTypeScript(resolve(dirname(filename), `${specifier}.ts`)), module, module.exports);
  return module.exports;
}
const {
  getSourceRequestHeaders,
  isRateLimitError,
  throwIfRateLimited,
  throwIfSourceForbidden,
} = loadTypeScript(fileURLToPath(new URL("../../src/lib/services/sourceRequests.ts", import.meta.url)));

const tokens = new Map();
globalThis.localStorage = { getItem: key => tokens.get(key) ?? null };
const responseError = (status, data = "", headers = {}) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data, headers },
});

test("Codeberg downloads include a User-Agent and no unrelated GitHub token", () => {
  tokens.set("provider-source-tokens_zendax@cb", "secret");
  const headers = getSourceRequestHeaders(
    "zendax@cb",
    "https://codeberg.org/zendax/vega-providers/raw/branch/main/manifest.json",
  );
  assert.equal(headers["User-Agent"], "VegaDesktop");
  assert.equal(headers.Authorization, undefined);
});

test("private GitHub downloads retain their token alongside the User-Agent", () => {
  tokens.set("provider-source-tokens_foo", "github-token");
  const headers = getSourceRequestHeaders(
    "foo",
    "https://raw.githubusercontent.com/foo/vega-providers/refs/heads/main/dist/test/posts.js",
  );
  assert.ok(headers["User-Agent"]);
  assert.equal(headers.Authorization, "token github-token");
});

test("a generic 403 reports denied access without claiming a rate limit", () => {
  const error = responseError(403, "Access denied");
  assert.equal(isRateLimitError(error), false);
  assert.doesNotThrow(() => throwIfRateLimited(error));
  assert.throws(() => throwIfSourceForbidden(error), /source denied access \(HTTP 403\)/);
});

test("429 and confirmed GitHub rate limits use a source-neutral message", () => {
  for (const error of [
    responseError(429),
    responseError(403, { message: "API rate limit exceeded" }),
    responseError(403, "", { "x-ratelimit-remaining": "0" }),
  ]) {
    assert.equal(isRateLimitError(error), true);
    assert.throws(() => throwIfRateLimited(error), /^Error: Provider source rate limit exceeded\./);
  }
});

test("missing files and network failures are not treated as rate limits", () => {
  for (const error of [null, responseError(404), new Error("Network Error")]) {
    assert.equal(isRateLimitError(error), false);
    assert.doesNotThrow(() => throwIfRateLimited(error));
    assert.doesNotThrow(() => throwIfSourceForbidden(error));
  }
});
