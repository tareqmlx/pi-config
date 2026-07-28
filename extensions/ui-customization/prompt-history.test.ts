import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_PROMPT_HISTORY,
  PromptHistory,
  PromptHistoryReplayGuard,
  readPromptHistory,
} from "./src/prompt-history.ts";

function withTempHistory(run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
  try {
    run(join(directory, "input-history.jsonl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("distinguishes anticipated transcript replay from real history additions", () => {
  const guard = new PromptHistoryReplayGuard();
  guard.expect([" first ", "second"]);

  assert.equal(guard.consume("first"), true);
  assert.equal(guard.consume("second"), true);
  assert.equal(guard.consume("follow-up"), false);

  guard.expect(["old prompt", "another old prompt"]);
  assert.equal(guard.consume("new submission"), false);
  assert.equal(guard.consume("old prompt"), false);
});

test("reads valid entries newest-first and ignores malformed lines", () => {
  withTempHistory((path) => {
    writeFileSync(
      path,
      [
        JSON.stringify({ display: "first" }),
        "not json",
        JSON.stringify({ display: 42 }),
        JSON.stringify({ display: "  second  " }),
        "",
      ].join("\n"),
    );

    assert.deepEqual(readPromptHistory(path), ["second", "first"]);
  });
});

test("limits loaded history to the editor capacity", () => {
  withTempHistory((path) => {
    const entries = Array.from({ length: MAX_PROMPT_HISTORY + 5 }, (_, index) =>
      JSON.stringify({ display: `prompt ${index}` }),
    );
    writeFileSync(path, `${entries.join("\n")}\n`);

    const history = readPromptHistory(path);
    assert.equal(history.length, MAX_PROMPT_HISTORY);
    assert.equal(history[0], `prompt ${MAX_PROMPT_HISTORY + 4}`);
    assert.equal(history.at(-1), "prompt 5");
  });
});

test("records trimmed prompts with project metadata and skips duplicates", () => {
  withTempHistory((path) => {
    const history = new PromptHistory(path, {
      project: "/tmp/project",
      sessionId: "session-1",
    });

    assert.equal(history.record("  first prompt  "), true);
    assert.equal(history.record("first prompt"), false);
    assert.equal(history.record("\n\t"), false);
    assert.equal(history.record("second prompt"), true);
    assert.deepEqual(history.values, ["second prompt", "first prompt"]);

    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.map(({ display, project, sessionId }) => ({
        display,
        project,
        sessionId,
      })),
      [
        {
          display: "first prompt",
          project: "/tmp/project",
          sessionId: "session-1",
        },
        {
          display: "second prompt",
          project: "/tmp/project",
          sessionId: "session-1",
        },
      ],
    );
    assert.equal(typeof entries[0].timestamp, "number");
  });
});

test("returns a persistence failure without interrupting submission", () => {
  withTempHistory((path) => {
    writeFileSync(path, "not a directory");
    const history = new PromptHistory(join(path, "history.jsonl"), {
      project: "/tmp/project",
      sessionId: "session-1",
    });

    assert.equal(history.record("still submit this"), false);
    assert.deepEqual(history.values, []);
  });
});

test("bounds the JSONL file to the editor history capacity", () => {
  withTempHistory((path) => {
    const history = new PromptHistory(path, {
      project: "/tmp/project",
      sessionId: "session-1",
    });

    for (let index = 0; index < MAX_PROMPT_HISTORY + 5; index += 1) {
      assert.equal(history.record(`prompt ${index}`), true);
    }

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, MAX_PROMPT_HISTORY);
    assert.equal(history.values[0], `prompt ${MAX_PROMPT_HISTORY + 4}`);
    assert.equal(history.values.at(-1), "prompt 5");
  });
});

test("serializes writers and suppresses cross-process consecutive duplicates", () => {
  withTempHistory((path) => {
    const metadata = { project: "/tmp/project", sessionId: "session-1" };
    const firstProcess = new PromptHistory(path, metadata);
    const secondProcess = new PromptHistory(path, metadata);

    assert.equal(firstProcess.record("same prompt"), true);
    assert.equal(secondProcess.record("same prompt"), false);
    assert.equal(secondProcess.record("another prompt"), true);
    assert.equal(firstProcess.record("another prompt"), false);

    assert.deepEqual(readPromptHistory(path), [
      "another prompt",
      "same prompt",
    ]);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  });
});
