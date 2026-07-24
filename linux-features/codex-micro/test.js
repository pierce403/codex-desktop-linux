#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  discoverBundledNodeHid,
  inspectElf,
  selectPrebuild,
  stageCodexMicroNativeBinding,
  validateArtifactManifest,
} = require("./native-binding.js");
const {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors,
  exportedFeatureGateHook,
  hasDirectCodexMicroGateCallsite,
  matchesCodexMicroFeatureGateContract,
} = require("./patch.js");
const {
  enabledLinuxFeaturePackageDependencies,
  enabledLinuxFeaturePackageFiles,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
  stageEnabledLinuxFeaturePackageResources,
} = require("../../scripts/lib/linux-features.js");

const NODE_HID_INTEGRITY =
  "sha512-j+dFgJLRAE0nufQKXk3IfS6T6YuHhCgMvz4TrG0sgtb6DSCdYpfJ1etcdmeCmPQjUgO+yo32ktVrRliNs/+fmg==";
const FIXTURE_NODE_HID_LOADER =
  "module.exports = require('pkg-prebuilds')(__dirname); // bundled loader\n";
const FIXTURE_NODE_HID_OPTIONS =
  "module.exports = { name: 'HID', tags: ['backend'] }; // bundled options\n";
const CURRENT_ARTIFACT = Object.freeze({
  name: "node-hid",
  version: "3.3.0",
  license: "(MIT OR X11)",
  integrity: NODE_HID_INTEGRITY,
  shasum: "2b00639e8bb9fc96592e8366fda7ae380826a7ee",
  loaderContract: Object.freeze({
    main: "./nodehid.js",
    napiVersions: Object.freeze([4]),
    files: Object.freeze({
      "nodehid.js":
        "84053a6ea19b238e61368f5220a9a8af96b27e752569f14d63dba2127a37988b",
      "binding-options.js":
        "e7c820107f3b6571ca1505a5ffbe17511088336e4c410ec718ea9ec200c6b1e6",
    }),
  }),
  prebuilds: Object.freeze({
    x64: Object.freeze({
      path: "prebuilds/HID_hidraw-linux-x64/node-napi-v4.node",
      sha256:
        "6c7f3b3fcc238a74e7e3237b50b2ff05181e94862b1963e8074ff8fc75885021",
    }),
    arm64: Object.freeze({
      path: "prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node",
      sha256:
        "06ea97f377e2246a1e9bf3770186727e72ff3c166579d9c259c6d32a07aeaa60",
    }),
  }),
});

function featureGateFixture(options = {}) {
  const callsite = options.callsite ?? `Rh(\`${CODEX_MICRO_GATE_ID}\`)`;
  return [
    "const warning=`useFeatureGate hook failed to find a valid StatsigClient`;",
    "function Lh(){return zh().isLoading}",
    "function Rh(e){return bnt(),Bo(Fh,e)}",
    "function Wh(e){return e}",
    `const codexMicroEnabled=${callsite};`,
    "function zh(){return bnt(),client()}",
    "export{zh as c,Lh as flt,Rh as rlt};",
  ].join("");
}

test("Codex Micro locally enables only its direct upstream gate callsite", () => {
  const source = featureGateFixture();
  const hook = exportedFeatureGateHook(source);

  assert.deepEqual(hook, {
    source: "function Rh(e){return bnt(),Bo(Fh,e)}",
    hookName: "Rh",
    argumentName: "e",
    contextHookName: "bnt",
    atomReadName: "Bo",
    gateAtomName: "Fh",
  });
  assert.equal(hasDirectCodexMicroGateCallsite(source, hook.hookName), true);
  assert.equal(matchesCodexMicroFeatureGateContract(source), true);

  const patched = applyCodexMicroFeatureGatePatch(source);
  assert.match(
    patched,
    new RegExp(
      `function Rh\\(e\\)\\{return bnt\\(\\),Bo\\(Fh,e\\)\\|\\|` +
        `e===\\\`${CODEX_MICRO_GATE_ID}\\\`/\\*${CODEX_MICRO_GATE_MARKER}\\*/\\}`,
    ),
  );
  assert.equal(applyCodexMicroFeatureGatePatch(patched), patched);
  assert.equal(matchesCodexMicroFeatureGateContract(patched), true);
  assert.doesNotMatch(patched, /e===`[^`]+`\|\|/);
});

test("gate matcher rejects a generic exported hook with no Micro callsite", () => {
  const source = featureGateFixture({ callsite: "Rh(`some-other-gate`)" });

  assert.ok(exportedFeatureGateHook(source));
  assert.equal(matchesCodexMicroFeatureGateContract(source), false);
  assert.equal(applyCodexMicroFeatureGatePatch(source), source);
});

test("gate matcher rejects the Micro ID passed through another function", () => {
  const source = featureGateFixture({
    callsite: `Wh(\`${CODEX_MICRO_GATE_ID}\`)`,
  });

  const hook = exportedFeatureGateHook(source);
  assert.equal(hook.hookName, "Rh");
  assert.equal(hasDirectCodexMicroGateCallsite(source, hook.hookName), false);
  assert.equal(matchesCodexMicroFeatureGateContract(source), false);
  assert.equal(applyCodexMicroFeatureGatePatch(source), source);
});

test("gate matcher rejects a lookalike hook that is not exported", () => {
  const source = featureGateFixture().replace(",Rh as rlt", "");

  assert.equal(exportedFeatureGateHook(source), null);
  assert.equal(matchesCodexMicroFeatureGateContract(source), false);
  assert.equal(applyCodexMicroFeatureGatePatch(source), source);
});

test("Codex Micro gate patch targets only the current app-initial shape", () => {
  const descriptor = descriptors.find(({ id }) => id === "webview-feature-gate");

  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-initial-C-fROkKo.js"), true);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~avatarOverlayCompositionSurface~notebook-preview-old.js",
    ),
    false,
  );
});

test("the shipped native artifact manifest pins exactly x64 and arm64", () => {
  const shipped = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "native-artifacts.json"),
      "utf8",
    ),
  );
  assert.deepEqual(shipped, CURRENT_ARTIFACT);
  assert.doesNotThrow(() => validateArtifactManifest(shipped));
  assert.deepEqual(Object.keys(shipped.prebuilds).sort(), ["arm64", "x64"]);
});

const DEVICE_KIT_RELATIVE = path.join(
  "node_modules",
  "@worklouder",
  "device-kit-oai",
);
const WORK_LOUDER_KIT_RELATIVE = path.join(
  DEVICE_KIT_RELATIVE,
  "node_modules",
  "@worklouder",
  "wl-device-kit",
);
const NODE_HID_RELATIVE = path.join(
  WORK_LOUDER_KIT_RELATIVE,
  "node_modules",
  "node-hid",
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    contents,
    mode == null ? undefined : { mode },
  );
}

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function makeElf(arch, marker = arch) {
  const machines = { x64: 62, arm64: 183 };
  const machine = machines[arch];
  if (machine == null) {
    throw new Error(`Unsupported ELF fixture architecture: ${arch}`);
  }

  const contents = Buffer.alloc(128);
  contents.set([0x7f, 0x45, 0x4c, 0x46], 0);
  contents[4] = 2;
  contents[5] = 1;
  contents[6] = 1;
  contents.writeUInt16LE(3, 16);
  contents.writeUInt16LE(machine, 18);
  contents.writeUInt32LE(1, 20);
  contents.write(marker, 64, "utf8");
  return contents;
}

function bindingRelativePath(arch) {
  return path.join(
    "prebuilds",
    `HID_hidraw-linux-${arch}`,
    "node-napi-v4.node",
  );
}

function createBundledFixture(t, options = {}) {
  const root = tempDirectory(t, "codex-micro-bundled-");
  const extractedDir = path.join(root, "app-extracted");
  const deviceKitDir = path.join(extractedDir, DEVICE_KIT_RELATIVE);
  const workLouderKitDir = path.join(extractedDir, WORK_LOUDER_KIT_RELATIVE);
  const nodeHidDir = path.join(extractedDir, NODE_HID_RELATIVE);

  fs.mkdirSync(extractedDir, { recursive: true });
  if (options.includeDeviceKit !== false) {
    writeJson(path.join(deviceKitDir, "package.json"), {
      name: "@worklouder/device-kit-oai",
      version: "0.1.11",
      dependencies: { "@worklouder/wl-device-kit": "0.1.23" },
    });
    writeFile(
      path.join(deviceKitDir, "dist/index.js"),
      "device-kit-oai bundled bytes\n",
    );
  }
  if (
    options.includeDeviceKit !== false &&
    options.includeWorkLouderKit !== false
  ) {
    writeJson(path.join(workLouderKitDir, "package.json"), {
      name: "@worklouder/wl-device-kit",
      version: "0.1.23",
      dependencies: { "node-hid": options.bundledVersion ?? "3.3.0" },
    });
    writeFile(
      path.join(workLouderKitDir, "dist/index.js"),
      "wl-device-kit bundled bytes\n",
    );
  }
  if (
    options.includeDeviceKit !== false &&
    options.includeWorkLouderKit !== false &&
    options.includeNodeHid !== false
  ) {
    writeJson(path.join(nodeHidDir, "package.json"), {
      name: "node-hid",
      version: options.bundledVersion ?? "3.3.0",
      license: options.bundledLicense ?? "(MIT OR X11)",
      main: options.bundledMain ?? "./nodehid.js",
      binary: {
        napi_versions: options.bundledNapiVersions ?? [4],
      },
    });
    writeFile(
      path.join(nodeHidDir, "nodehid.js"),
      options.nodeHidLoader ?? FIXTURE_NODE_HID_LOADER,
    );
    writeFile(
      path.join(nodeHidDir, "binding-options.js"),
      FIXTURE_NODE_HID_OPTIONS,
    );
    writeFile(
      path.join(
        nodeHidDir,
        "prebuilds/HID-darwin-arm64/node-napi-v4.node",
      ),
      "bundled Mach-O bytes",
    );
  }

  writeJson(
    path.join(extractedDir, "node_modules/node-hid/package.json"),
    {
      name: "node-hid",
      version: "99.0.0",
    },
  );
  if (options.includeDeviceKit !== false) {
    writeJson(
      path.join(deviceKitDir, "node_modules/node-hid/package.json"),
      {
        name: "node-hid",
        version: "98.0.0",
      },
    );
  }

  return {
    extractedDir,
    deviceKitDir,
    workLouderKitDir,
    nodeHidDir,
  };
}

function fixtureArtifact(binaries = {}) {
  const x64 = binaries.x64 ?? makeElf("x64", "fixture-x64");
  const arm64 = binaries.arm64 ?? makeElf("arm64", "fixture-arm64");
  return {
    ...CURRENT_ARTIFACT,
    loaderContract: {
      main: "./nodehid.js",
      napiVersions: [4],
      files: {
        "nodehid.js": sha256(FIXTURE_NODE_HID_LOADER),
        "binding-options.js": sha256(FIXTURE_NODE_HID_OPTIONS),
      },
    },
    prebuilds: {
      x64: {
        path: CURRENT_ARTIFACT.prebuilds.x64.path,
        sha256: sha256(x64),
      },
      arm64: {
        path: CURRENT_ARTIFACT.prebuilds.arm64.path,
        sha256: sha256(arm64),
      },
    },
  };
}

function createMaterializedPackage(t, options = {}) {
  const packageDir = path.join(
    tempDirectory(t, "codex-micro-node-hid-artifact-"),
    "package",
  );
  writeJson(path.join(packageDir, "package.json"), {
    name: "node-hid",
    version: "3.3.0",
    license: "(MIT OR X11)",
    main: "nodehid.js",
    scripts: { install: "this must never be run" },
    ...options.packageMetadata,
  });
  writeFile(
    path.join(packageDir, "nodehid.js"),
    "throw new Error('artifact JS must not be copied');\n",
  );
  writeFile(
    path.join(packageDir, "README.md"),
    "artifact documentation must not be copied\n",
  );
  writeFile(
    path.join(packageDir, "src/hid.cc"),
    "artifact source must not be copied\n",
  );
  for (const [arch, binary] of Object.entries(options.binaries ?? {})) {
    writeFile(path.join(packageDir, bindingRelativePath(arch)), binary, 0o755);
  }
  return packageDir;
}

function bundledSnapshots(fixture) {
  return new Map(
    [
      "package.json",
      "nodehid.js",
      "binding-options.js",
      "prebuilds/HID-darwin-arm64/node-napi-v4.node",
    ].map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(fixture.nodeHidDir, relativePath)),
    ]),
  );
}

function assertBundledSnapshots(fixture, snapshots) {
  for (const [relativePath, expected] of snapshots) {
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.nodeHidDir, relativePath)),
      expected,
      `${relativePath} changed`,
    );
  }
}

test("discovers only the current nested Work Louder node-hid package", (t) => {
  const fixture = createBundledFixture(t);

  const discovered = discoverBundledNodeHid(fixture.extractedDir);

  assert.equal(discovered.deviceKitDir, fixture.deviceKitDir);
  assert.equal(discovered.workLouderKitDir, fixture.workLouderKitDir);
  assert.equal(discovered.nodeHidDir, fixture.nodeHidDir);
  assert.equal(discovered.name, "node-hid");
  assert.equal(discovered.version, "3.3.0");
});

for (const arch of ["x64", "arm64"]) {
  test(`stages only the pinned verified ${arch} prebuild`, async (t) => {
    const binary = makeElf(arch, `verified-${arch}`);
    const otherArch = arch === "x64" ? "arm64" : "x64";
    const artifactManifest = fixtureArtifact({ [arch]: binary });
    const fixture = createBundledFixture(t);
    const packageDir = createMaterializedPackage(t, {
      binaries: {
        [arch]: binary,
        [otherArch]: makeElf(otherArch, "must-not-be-copied"),
      },
    });
    const snapshots = bundledSnapshots(fixture);
    let cleanupCalls = 0;

    const result = await stageCodexMicroNativeBinding({
      extractedDir: fixture.extractedDir,
      arch,
      artifactManifest,
      materializePackage: async (request) => {
        assert.deepEqual(request, {
          name: "node-hid",
          version: "3.3.0",
          integrity: NODE_HID_INTEGRITY,
          shasum: CURRENT_ARTIFACT.shasum,
        });
        return {
          packageDir,
          integrity: NODE_HID_INTEGRITY,
          cleanup: () => {
            cleanupCalls += 1;
          },
        };
      },
    });

    const targetPath = path.join(
      fixture.nodeHidDir,
      bindingRelativePath(arch),
    );
    assert.equal(result.changed, true);
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.source, "prebuild");
    assert.equal(result.targetPath, targetPath);
    assert.deepEqual(fs.readFileSync(targetPath), binary);
    assert.equal(fs.statSync(targetPath).mode & 0o777, 0o755);
    assert.equal(
      fs.existsSync(
        path.join(fixture.nodeHidDir, bindingRelativePath(otherArch)),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.nodeHidDir, "README.md")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.nodeHidDir, "src/hid.cc")),
      false,
    );
    assert.equal(cleanupCalls, 1);
    assertBundledSnapshots(fixture, snapshots);
  });
}

test("a hash-valid existing binding normalizes its mode without materialization", async (t) => {
  const binary = makeElf("x64", "already-correct");
  const artifactManifest = fixtureArtifact({ x64: binary });
  const fixture = createBundledFixture(t);
  const targetPath = path.join(
    fixture.nodeHidDir,
    bindingRelativePath("x64"),
  );
  writeFile(targetPath, binary, 0o700);

  const result = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    artifactManifest,
    materializePackage: async () => {
      throw new Error("correct existing binding must not fetch");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.source, "existing");
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(targetPath), binary);
});

test("a hash-valid executable binding is idempotent without materialization", async (t) => {
  const binary = makeElf("x64", "already-correct-and-executable");
  const artifactManifest = fixtureArtifact({ x64: binary });
  const fixture = createBundledFixture(t);
  const targetPath = path.join(
    fixture.nodeHidDir,
    bindingRelativePath("x64"),
  );
  writeFile(targetPath, binary, 0o755);

  const result = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    artifactManifest,
    materializePackage: async () => {
      throw new Error("correct existing binding must not fetch");
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.source, "existing");
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(targetPath), binary);
});

test("unsupported architectures fail before package discovery or fetch", async () => {
  let materializeCalls = 0;
  await assert.rejects(
    stageCodexMicroNativeBinding({
      extractedDir: "/does/not/exist",
      arch: "riscv64",
      artifactManifest: fixtureArtifact(),
      materializePackage: async () => {
        materializeCalls += 1;
      },
    }),
    /unsupported.*architecture.*riscv64/i,
  );
  assert.equal(materializeCalls, 0);
});

test("a missing architecture pin fails before package discovery or fetch", async () => {
  const artifactManifest = fixtureArtifact();
  delete artifactManifest.prebuilds.x64;
  let materializeCalls = 0;

  await assert.rejects(
    stageCodexMicroNativeBinding({
      extractedDir: "/does/not/exist",
      arch: "x64",
      artifactManifest,
      materializePackage: async () => {
        materializeCalls += 1;
      },
    }),
    /must pin x64 and arm64 prebuilds/i,
  );
  assert.equal(materializeCalls, 0);
});

for (const scenario of [
  {
    label: "version",
    fixtureOptions: { bundledVersion: "3.2.0" },
    expected: /version.*3\.3\.0.*3\.2\.0/i,
  },
  {
    label: "license",
    fixtureOptions: { bundledLicense: "UNLICENSED" },
    expected: /license.*MIT OR X11.*UNLICENSED/i,
  },
  {
    label: "loader entrypoint",
    fixtureOptions: { bundledMain: "./other.js" },
    expected: /loader entrypoint.*nodehid\.js.*other\.js/i,
  },
  {
    label: "N-API contract",
    fixtureOptions: { bundledNapiVersions: [8] },
    expected: /N-API contract.*\[4\].*\[8\]/i,
  },
  {
    label: "loader hash",
    fixtureOptions: { nodeHidLoader: "tampered loader\n" },
    expected: /loader contract hash mismatch.*nodehid\.js/i,
  },
]) {
  test(`bundled node-hid ${scenario.label} drift fails before fetch`, async (t) => {
    const fixture = createBundledFixture(t, scenario.fixtureOptions);
    let materializeCalls = 0;

    await assert.rejects(
      stageCodexMicroNativeBinding({
        extractedDir: fixture.extractedDir,
        arch: "x64",
        artifactManifest: fixtureArtifact(),
        materializePackage: async () => {
          materializeCalls += 1;
        },
      }),
      scenario.expected,
    );
    assert.equal(materializeCalls, 0);
  });
}

for (const scenario of [
  {
    label: "identity",
    packageMetadata: { name: "not-node-hid" },
    integrity: NODE_HID_INTEGRITY,
    expected: /identity.*node-hid/i,
  },
  {
    label: "version",
    packageMetadata: { version: "3.3.1" },
    integrity: NODE_HID_INTEGRITY,
    expected: /version.*3\.3\.0.*3\.3\.1/i,
  },
  {
    label: "license",
    packageMetadata: { license: "UNLICENSED" },
    integrity: NODE_HID_INTEGRITY,
    expected: /license.*MIT OR X11.*UNLICENSED/i,
  },
  {
    label: "integrity",
    packageMetadata: {},
    integrity: "sha512-unverified",
    expected: /integrity/i,
  },
]) {
  test(`rejects a materialized package with wrong ${scenario.label}`, async (t) => {
    const binary = makeElf("x64", `wrong-${scenario.label}`);
    const fixture = createBundledFixture(t);
    const packageDir = createMaterializedPackage(t, {
      packageMetadata: scenario.packageMetadata,
      binaries: { x64: binary },
    });

    await assert.rejects(
      stageCodexMicroNativeBinding({
        extractedDir: fixture.extractedDir,
        arch: "x64",
        artifactManifest: fixtureArtifact({ x64: binary }),
        materializePackage: async () => ({
          packageDir,
          integrity: scenario.integrity,
        }),
      }),
      scenario.expected,
    );
    assert.equal(
      fs.existsSync(
        path.join(fixture.nodeHidDir, bindingRelativePath("x64")),
      ),
      false,
    );
  });
}

test("rejects a missing pinned prebuild without copying package files", async (t) => {
  const binary = makeElf("x64", "missing");
  const fixture = createBundledFixture(t);
  const packageDir = createMaterializedPackage(t);

  await assert.rejects(
    stageCodexMicroNativeBinding({
      extractedDir: fixture.extractedDir,
      arch: "x64",
      artifactManifest: fixtureArtifact({ x64: binary }),
      materializePackage: async () => ({
        packageDir,
        integrity: NODE_HID_INTEGRITY,
      }),
    }),
    /pinned node-hid prebuild is missing/i,
  );
  assert.equal(
    fs.existsSync(path.join(fixture.nodeHidDir, "README.md")),
    false,
  );
});

test("rejects a hash-valid prebuild whose ELF architecture is wrong", async (t) => {
  const arm64Binary = makeElf("arm64", "arm64-under-x64-path");
  const artifactManifest = fixtureArtifact();
  artifactManifest.prebuilds.x64.sha256 = sha256(arm64Binary);
  const fixture = createBundledFixture(t);
  const packageDir = createMaterializedPackage(t, {
    binaries: { x64: arm64Binary },
  });

  await assert.rejects(
    stageCodexMicroNativeBinding({
      extractedDir: fixture.extractedDir,
      arch: "x64",
      artifactManifest,
      materializePackage: async () => ({
        packageDir,
        integrity: NODE_HID_INTEGRITY,
      }),
    }),
    /ELF architecture arm64.*x64/i,
  );
});

test("rejects a same-architecture prebuild whose SHA-256 is wrong", async (t) => {
  const actual = makeElf("x64", "tampered");
  const expected = makeElf("x64", "expected");
  const fixture = createBundledFixture(t);
  const packageDir = createMaterializedPackage(t, {
    binaries: { x64: actual },
  });

  await assert.rejects(
    stageCodexMicroNativeBinding({
      extractedDir: fixture.extractedDir,
      arch: "x64",
      artifactManifest: fixtureArtifact({ x64: expected }),
      materializePackage: async () => ({
        packageDir,
        integrity: NODE_HID_INTEGRITY,
      }),
    }),
    /SHA-256 mismatch/i,
  );
});

test("inspectElf identifies supported 64-bit little-endian machines", () => {
  assert.equal(inspectElf(makeElf("x64")).arch, "x64");
  assert.equal(inspectElf(makeElf("arm64")).arch, "arm64");
  assert.equal(selectPrebuild(fixtureArtifact(), "x64").path, bindingRelativePath("x64"));
  assert.equal(selectPrebuild(fixtureArtifact(), "arm64").path, bindingRelativePath("arm64"));
});

test("inspectElf rejects invalid binary formats", () => {
  assert.throws(() => inspectElf(Buffer.from("not an ELF")), /ELF/i);

  const elf32 = makeElf("x64");
  elf32[4] = 1;
  assert.throws(() => inspectElf(elf32), /64-bit|ELF class/i);

  const bigEndian = makeElf("x64");
  bigEndian[5] = 2;
  assert.throws(() => inspectElf(bigEndian), /little-endian|ELF encoding/i);

  const unknownMachine = makeElf("x64");
  unknownMachine.writeUInt16LE(243, 18);
  assert.throws(
    () => inspectElf(unknownMachine),
    /unsupported.*ELF machine|machine.*243/i,
  );
});

test("udev policy imports USB identity before its narrow interface grant", () => {
  const rulePath = path.join(
    __dirname,
    "resources",
    "70-codex-micro.rules",
  );
  const source = fs.readFileSync(rulePath, "utf8");
  const activeRules = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  assert.equal(activeRules.length, 3);
  const [usbImport, usbGrant, bluetoothGrant] = activeRules;
  for (const rule of activeRules) {
    assert.match(rule, /(?:^|,\s*)SUBSYSTEM=="hidraw"(?:,|$)/);
    assert.match(rule, /KERNEL=="hidraw\*"/);
  }

  assert.match(usbImport, /ATTRS\{idVendor\}=="303a"/i);
  assert.match(usbImport, /ATTRS\{idProduct\}=="8360"/i);
  assert.match(usbImport, /^ACTION!="remove"/);
  assert.match(usbImport, /SUBSYSTEMS=="usb"/);
  assert.match(usbImport, /IMPORT\{builtin\}="usb_id"/);
  assert.doesNotMatch(usbImport, /TAG\+="uaccess"|MODE=/);

  assert.match(usbGrant, /ENV\{ID_VENDOR_ID\}=="303a"/i);
  assert.match(usbGrant, /ENV\{ID_MODEL_ID\}=="8360"/i);
  assert.match(usbGrant, /ENV\{ID_USB_INTERFACE_NUM\}=="00"/);
  assert.doesNotMatch(usbGrant, /IMPORT\{builtin\}/);
  assert.doesNotMatch(usbGrant, /KERNELS=="0005:/);

  assert.match(bluetoothGrant, /KERNELS=="0005:303A:8360\.\*"/);
  assert.doesNotMatch(bluetoothGrant, /ID_USB_INTERFACE_NUM|IMPORT\{builtin\}/);
  assert.doesNotMatch(
    bluetoothGrant,
    /HID_UNIQ|[0-9A-F]{2}(?::[0-9A-F]{2}){5}/i,
  );

  for (const rule of [usbGrant, bluetoothGrant]) {
    assert.match(rule, /TAG\+="uaccess"/);
    assert.match(rule, /MODE="0660"/);
  }
  assert.doesNotMatch(source, /MODE="0666"|SUBSYSTEM=="usb"/);
});

test("feature manifest uses app resource plus package dependencies only", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"),
  );
  assert.deepEqual(manifest.resources, [
    {
      source: "resources/70-codex-micro.rules",
      target: ".codex-linux/features/codex-micro/70-codex-micro.rules",
      mode: "0644",
    },
  ]);
  assert.deepEqual(manifest.packageDependencies, {
    deb: ["libudev1", "libusb-1.0-0"],
    rpm: [
      "libudev.so.1%{codex_elf_suffix}",
      "libusb-1.0.so.0%{codex_elf_suffix}",
    ],
    pacman: ["systemd-libs", "libusb"],
  });
  assert.equal(Object.hasOwn(manifest, "packageResources"), false);
  assert.equal(Object.hasOwn(manifest, "packageHooks"), false);
  assert.equal(
    fs.existsSync(
      path.join(__dirname, "resources", "codex-micro-udev.hook"),
    ),
    false,
  );
  assert.equal(fs.existsSync(path.join(__dirname, "source-build")), false);
});

function featureOptions(t, enabled) {
  const root = tempDirectory(t, "codex-micro-feature-config-");
  const configPath = path.join(root, "features.json");
  writeJson(configPath, { enabled });
  return {
    featuresRoot: path.resolve(__dirname, ".."),
    featuresConfigPath: configPath,
  };
}

test("disabled codex-micro performs no patch or package work", (t) => {
  const options = featureOptions(t, []);

  assert.deepEqual(loadLinuxFeaturePatchDescriptors(options), []);
  for (const packageFormat of ["deb", "rpm", "pacman"]) {
    assert.deepEqual(
      enabledLinuxFeaturePackageDependencies({
        ...options,
        packageFormat,
      }),
      [],
    );
    assert.deepEqual(
      enabledLinuxFeaturePackageFiles({ ...options, packageFormat }),
      [],
    );
  }
});

test("enabled codex-micro stages its app rule but no package resources", (t) => {
  const options = featureOptions(t, ["codex-micro"]);
  const appDir = path.join(
    tempDirectory(t, "codex-micro-app-resource-"),
    "codex-app",
  );
  const expectedRule = fs.readFileSync(
    path.join(__dirname, "resources", "70-codex-micro.rules"),
  );

  const installPlan = stageEnabledLinuxFeatureInstall(appDir, options);
  assert.deepEqual(
    installPlan.resources.map(({ id, target, mode }) => ({
      id,
      target,
      mode,
    })),
    [
      {
        id: "codex-micro",
        target: ".codex-linux/features/codex-micro/70-codex-micro.rules",
        mode: 0o644,
      },
    ],
  );
  const stagedRule = path.join(
    appDir,
    ".codex-linux",
    "features",
    "codex-micro",
    "70-codex-micro.rules",
  );
  assert.deepEqual(fs.readFileSync(stagedRule), expectedRule);
  assert.equal(fs.statSync(stagedRule).mode & 0o777, 0o644);

  const expectedDependencies = {
    deb: ["libudev1", "libusb-1.0-0"],
    rpm: [
      "libudev.so.1%{codex_elf_suffix}",
      "libusb-1.0.so.0%{codex_elf_suffix}",
    ],
    pacman: ["libusb", "systemd-libs"],
  };
  for (const packageFormat of ["deb", "rpm", "pacman"]) {
    const packageRoot = path.join(
      tempDirectory(t, `codex-micro-${packageFormat}-package-`),
      "root",
    );
    const packageOptions = { ...options, packageFormat };
    const plan = stageEnabledLinuxFeaturePackageResources(
      packageRoot,
      packageOptions,
    );
    assert.deepEqual(plan.resources, []);
    assert.deepEqual(plan.dependencies, expectedDependencies[packageFormat]);
    assert.deepEqual(
      enabledLinuxFeaturePackageDependencies(packageOptions),
      expectedDependencies[packageFormat],
    );
    assert.deepEqual(enabledLinuxFeaturePackageFiles(packageOptions), []);
    assert.equal(
      fs.existsSync(
        path.join(
          packageRoot,
          "usr/lib/udev/rules.d/70-codex-micro.rules",
        ),
      ),
      false,
    );
  }
});

test("README documents manual policy and runtime verification", () => {
  const source = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");

  for (const installType of [
    "Debian",
    "RPM",
    "pacman",
    "AppImage",
    "Nix",
    "Home Manager",
    "source",
  ]) {
    assert.match(source, new RegExp(installType, "i"));
  }
  assert.match(source, /sudo install -Dm0644/);
  assert.match(source, /udevadm control --reload-rules/);
  assert.match(source, /libudev\.so\.1/);
  assert.match(source, /libusb-1\.0\.so\.0/);
  assert.match(source, /Fedora.*systemd-libs.*libusb1/is);
  assert.match(source, /Nix and Home Manager.*RPATH closure/is);
  assert.match(source, /\bldd\b/);
  assert.match(source, /not found/);
  assert.match(source, /never compiles native code/i);
});

test("feature tree contains no source compilation or package hook artifacts", () => {
  const entries = [];
  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relativePath);
      } else {
        entries.push(relativePath);
      }
    }
  }
  walk(__dirname);
  assert.deepEqual(entries.sort(), [
    "README.md",
    "feature.json",
    "native-artifacts.json",
    "native-binding.js",
    "patch.js",
    "resources/70-codex-micro.rules",
    "test.js",
  ]);

  const nativeSource = fs.readFileSync(
    path.join(__dirname, "native-binding.js"),
    "utf8",
  );
  assert.doesNotMatch(
    nativeSource,
    /defaultBuildFromSource|buildFromSource|sourceBuild|provenance|electronVersion|requirePrebuild/,
  );
});
