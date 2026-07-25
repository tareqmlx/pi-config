import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import {
  buildSubagentSpawnParameterDescriptions,
  buildSubagentSpawnPromptGuidelines,
  buildSubagentSpawnPromptSnippet,
  buildSubagentSpawnToolDescription,
} from "./src/prompt.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";
import { enabledBackendNames, loadSubagentSettings } from "./src/settings.ts";

function withTempAgentDir(run: (directory: string) => void) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagent-settings-"),
  );
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Claude subagents are enabled by default", () => {
  withTempAgentDir((directory) => {
    const settings = loadSubagentSettings(directory);
    assert.equal(settings.enableClaudeSubagent, true);
    assert.deepEqual(enabledBackendNames(settings), ["pi", "claude", "codex"]);
  });
});

test("enableClaudeSubagent false removes Claude from model-facing metadata", () => {
  withTempAgentDir((directory) => {
    fs.writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify({ enableClaudeSubagent: false }),
    );
    const backends = enabledBackendNames(loadSubagentSettings(directory));
    assert.deepEqual(backends, ["pi", "codex"]);

    const metadata = [
      buildSubagentSpawnToolDescription(backends),
      buildSubagentSpawnPromptSnippet(backends),
      ...buildSubagentSpawnPromptGuidelines(backends),
      ...Object.values(buildSubagentSpawnParameterDescriptions(backends)),
    ].join("\n");
    assert.doesNotMatch(metadata, /claude/i);
  });
});

test("non-boolean and malformed settings retain the enabled default", () => {
  withTempAgentDir((directory) => {
    const settingsFile = path.join(directory, "settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ enableClaudeSubagent: "no" }),
    );
    assert.equal(loadSubagentSettings(directory).enableClaudeSubagent, true);
    fs.writeFileSync(settingsFile, "{");
    assert.equal(loadSubagentSettings(directory).enableClaudeSubagent, true);
  });
});

test("disabled runtime rejects Claude spawns before launching a backend", async () => {
  const runtime = createSubagentRuntime({ enabledBackends: ["pi", "codex"] });
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("claude", {
          prompt: "This must not run",
          title: "disabled Claude",
          cwd: process.cwd(),
          parent: {
            parentCwd: process.cwd(),
            projectTrusted: false,
          },
        }),
      ),
      /Unknown backend "claude"/,
    );

    const registeredBackends = await runtime.runPromise(
      Effect.map(manager.list, (subagents) =>
        subagents.map((subagent) => subagent.backend),
      ),
    );
    assert.deepEqual(registeredBackends, []);
  } finally {
    await runtime.dispose();
  }
});
