import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const configUrl = new URL("./config.ts", import.meta.url).href;
const cliUrl = new URL("./cli.ts", import.meta.url).href;

// Intercept filesystem access before loading the application. No real or dummy
// secrets files are created or opened, even if this test catches a regression.
const guard = `
  import fs from 'node:fs';
  import { basename } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { syncBuiltinESMExports } from 'node:module';
  for (const name of ['existsSync', 'readFileSync', 'openSync', 'accessSync', 'statSync']) {
    const original = fs[name];
    fs[name] = function(path, ...args) {
      const value = path instanceof URL ? fileURLToPath(path) : String(path);
      if (/^\\.env(?:\\.|$)/.test(basename(value))) {
        throw new Error('SECRET_FILE_ACCESS_BLOCKED');
      }
      return original.call(this, path, ...args);
    };
  }
  syncBuiltinESMExports();
  // Commander must see the argv layout of a file entry point, not node -e.
  process.execArgv = [];
`;

function runGuarded(code: string, inheritedKey = "") {
  const cwd = mkdtempSync(join(tmpdir(), "task-runner-config-test-"));
  try {
    writeFileSync(join(cwd, "task-runner.config.json"), JSON.stringify({ projects: {} }));
    return spawnSync(process.execPath, [
      "--experimental-strip-types", "--input-type=module", "-e", guard + code,
    ], {
      cwd,
      env: { ...process.env, LINEAR_API_KEY: inheritedKey, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 15_000,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("agent-safe configuration", () => {
  it("imports configuration without probing or reading .env", () => {
    const result = runGuarded(`await import(${JSON.stringify(configUrl)});`);
    assert.equal(result.status, 0, result.stderr);
  });

  it("uses the inherited key without accessing a secrets file", () => {
    const result = runGuarded(`
      const { getLinearApiKey } = await import(${JSON.stringify(configUrl)});
      if (getLinearApiKey() !== 'test-inherited-value') process.exitCode = 1;
    `, "test-inherited-value");
    assert.equal(result.status, 0, result.stderr);
  });

  it("shows CLI help without credentials or secret-file access", () => {
    const result = runGuarded(`
      process.argv = ['node', 'task-runner', '--help'];
      await import(${JSON.stringify(cliUrl)});
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /refine-tickets/);
  });

  it("fails an authenticated command with operator instructions when no key is inherited", () => {
    const result = runGuarded(`
      process.argv = ['node', 'task-runner', 'list-tickets', '--team', 'JOS'];
      await import(${JSON.stringify(cliUrl)});
    `);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /Ask the operator to verify/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_FILE_ACCESS_BLOCKED/);
  });
});
