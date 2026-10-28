import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { grokProfileIdentity, GROK_PROFILE_SOURCE_FILES, GROK_PROFILE_VERSION } from "./grok-profile-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
test("the active Grok profile attests its exact admission source", () => {
  const identity = grokProfileIdentity(root);
  const manifest = JSON.parse(readFileSync(join(root, "packages/paperclip-runner/acpx-profiles.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(join(root, `packages/paperclip-runner/test/fixtures/grok-profile-v${GROK_PROFILE_VERSION}-identity.json`), "utf8"));
  assert.deepEqual(identity, fixture);
  assert.equal(manifest.profiles.grok.commandDigest, identity.commandDigest);
  assert.equal(manifest.profiles.grok.agentProfileVersion, GROK_PROFILE_VERSION);
});

test("changing the session.open contract invalidates the Grok identity", () => {
  const copy = mkdtempSync(join(tmpdir(), "grok-profile-source-"));
  try {
    for (const path of ["packages/paperclip-runner/acpx-profiles.json", ...GROK_PROFILE_SOURCE_FILES]) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      copyFileSync(join(root, path), join(copy, path));
    }
    const before = grokProfileIdentity(copy);
    const sidecar = join(copy, "packages/paperclip-runner/src/cli/acpx-runtime-sidecar.ts");
    const source = readFileSync(sidecar, "utf8");
    assert.ok(source.includes('"grokEffort"'));
    writeFileSync(sidecar, source.replace('"grokEffort"', '"obsoleteGrokEffort"'));
    assert.notEqual(grokProfileIdentity(copy).commandDigest, before.commandDigest);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
