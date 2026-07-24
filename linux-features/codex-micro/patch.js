"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const {
  extractedAppPatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const CODEX_MICRO_GATE_ID = "3207467860";
const CODEX_MICRO_GATE_MARKER = "codexLinuxCodexMicroGateOverride";
const JS_IDENT = "[A-Za-z_$][\\w$]*";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exportedFeatureGateHook(source) {
  const exportStart = source.lastIndexOf("export{");
  const exportEnd = exportStart < 0 ? -1 : source.indexOf("}", exportStart);
  if (exportStart < 0 || exportEnd < 0) {
    return null;
  }

  const exportBlock = source.slice(exportStart, exportEnd + 1);
  const candidates = new RegExp(
    `function (${JS_IDENT})\\((${JS_IDENT})\\)\\{return ` +
      `(${JS_IDENT})\\(\\),(${JS_IDENT})\\((${JS_IDENT}),\\2\\)` +
      `(?:\\|\\|\\2===\`${CODEX_MICRO_GATE_ID}\`/\\*${CODEX_MICRO_GATE_MARKER}\\*/)?\\}`,
    "g",
  );
  const exportedCandidates = [];
  for (const match of source.matchAll(candidates)) {
    const hookName = match[1];
    const exportedAsGateHook = new RegExp(
      `(?:\\{|,)${escapeRegExp(hookName)} as ${JS_IDENT}(?:,|\\})`,
    );
    if (exportedAsGateHook.test(exportBlock)) {
      exportedCandidates.push({
        source: match[0],
        hookName,
        argumentName: match[2],
        contextHookName: match[3],
        atomReadName: match[4],
        gateAtomName: match[5],
      });
    }
  }
  return exportedCandidates.length === 1 ? exportedCandidates[0] : null;
}

function hasDirectCodexMicroGateCallsite(source, hookName) {
  const directCallsite = new RegExp(
    `(?:^|[^\\w$])${escapeRegExp(hookName)}\\(\\s*` +
      `\`${CODEX_MICRO_GATE_ID}\`\\s*\\)`,
  );
  return directCallsite.test(source);
}

function matchesCodexMicroFeatureGateContract(source) {
  if (typeof source !== "string") {
    return false;
  }
  const hook = exportedFeatureGateHook(source);
  return source.includes("useFeatureGate hook failed to find a valid StatsigClient") &&
    hook != null &&
    hasDirectCodexMicroGateCallsite(source, hook.hookName);
}

function applyCodexMicroFeatureGatePatch(source) {
  if (
    typeof source !== "string" ||
    source.includes(CODEX_MICRO_GATE_MARKER) ||
    !matchesCodexMicroFeatureGateContract(source)
  ) {
    return source;
  }

  const hook = exportedFeatureGateHook(source);
  const replacement =
    `function ${hook.hookName}(${hook.argumentName}){return ` +
    `${hook.contextHookName}(),${hook.atomReadName}(${hook.gateAtomName},${hook.argumentName})||` +
    `${hook.argumentName}===\`${CODEX_MICRO_GATE_ID}\`/*${CODEX_MICRO_GATE_MARKER}*/}`;
  return source.replace(hook.source, replacement);
}

function stageNativeBinding(extractedDir) {
  const helper = path.join(__dirname, "native-binding.js");
  const output = childProcess.execFileSync(process.execPath, [helper, "--stage", extractedDir], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

module.exports = {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors: [
    webviewAssetPatch({
      id: "webview-feature-gate",
      order: 28_990,
      ciPolicy: "opt-in",
      pattern: /^app-initial-[A-Za-z0-9_-]+\.js$/,
      assetMatch: matchesCodexMicroFeatureGateContract,
      missingDescription: "current Codex Micro feature-gate webview bundle",
      skipDescription: "Codex Micro feature-gate override",
      apply: applyCodexMicroFeatureGatePatch,
    }),
    extractedAppPatch({
      id: "linux-node-hid-binding",
      phase: "extracted-app:post-webview",
      order: 29_000,
      ciPolicy: "opt-in",
      targetSummary: "current Work Louder node-hid 3.3.0 nested dependency",
      apply: (extractedDir) => stageNativeBinding(extractedDir),
      status: (result) => ({
        status: result?.changed ? "applied" : result?.alreadyApplied ? "already-applied" : "skipped-optional",
        reason: result == null
          ? "node-hid binding staging returned no result"
          : `${result.source} node-hid ${result.version}`,
      }),
    }),
  ],
  exportedFeatureGateHook,
  hasDirectCodexMicroGateCallsite,
  matchesCodexMicroFeatureGateContract,
};
