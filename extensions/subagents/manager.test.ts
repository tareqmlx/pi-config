/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentEvent,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
      betweenTurnsMs: 100,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

function createScriptedRuntime(
  events: ReadonlyArray<SubagentEvent>,
  onClose: () => void,
) {
  const registry = Layer.sync(BackendRegistry, () => {
    const backend: SubagentBackend = {
      name: "codex",
      capabilities: {
        steering: true,
        modelSelection: true,
        reasoningEffort: true,
      },
      available: Effect.succeed(true),
      spawn: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(onClose));
          return {
            meta: Effect.succeed({
              backend: "codex" as const,
              modelLabel: "codex/scripted",
            }),
            events: Stream.fromIterable(events),
            send: () => Effect.void,
            interrupt: Effect.void,
          };
        }),
    };
    return new Map<BackendName, SubagentBackend>([[backend.name, backend]]);
  });
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

function createNoopInterruptRuntime(
  onClose: () => void,
  interruptPartialText?: string,
) {
  const registry = Layer.sync(BackendRegistry, () => {
    const backend: SubagentBackend = {
      name: "codex",
      capabilities: {
        steering: true,
        modelSelection: true,
        reasoningEffort: true,
      },
      available: Effect.succeed(true),
      spawn: () =>
        Effect.gen(function* () {
          const events = yield* Queue.make<SubagentEvent, Cause.Done>();
          Queue.offerUnsafe(events, { _tag: "RunStarted" });
          Queue.offerUnsafe(events, {
            _tag: "QueueChanged",
            queued: [{ text: "accepted follow-up", kind: "follow-up" }],
          });
          Queue.offerUnsafe(events, {
            _tag: "RunSettled",
            outcome: { _tag: "Completed", finalText: "first result" },
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              onClose();
              Queue.endUnsafe(events);
            }),
          );
          return {
            meta: Effect.succeed({
              backend: "codex" as const,
              modelLabel: "codex/noop-interrupt",
            }),
            events: Stream.fromQueue(events),
            send: () => Effect.void,
            // Models a backend drain gap with no active native turn. The
            // optional event is offered immediately before interrupt resolves,
            // matching the production backends' queue/pump ordering.
            interrupt:
              interruptPartialText === undefined
                ? Effect.void
                : Effect.sync(() => {
                    Queue.offerUnsafe(events, {
                      _tag: "RunSettled",
                      outcome: {
                        _tag: "Interrupted",
                        partialText: interruptPartialText,
                      },
                    });
                  }),
          };
        }),
    };
    return new Map<BackendName, SubagentBackend>([[backend.name, backend]]);
  });
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("final settlement closes the backend scope exactly once", async () => {
  let closeCount = 0;
  const CleanupRegistryLive = Layer.sync(BackendRegistry, () => {
    const backend = makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/test",
      contextWindow: 32_000,
      toolName: "shell",
      cadenceMs: 1,
      onClose: () => closeCount++,
    });
    return new Map<BackendName, SubagentBackend>([[backend.name, backend]]);
  });
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(CleanupRegistryLive)),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("close this session")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    for (let attempt = 0; attempt < 100 && closeCount === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(closeCount, 1);
    assert.equal(manager.view.get(snap.id)?.status, "done");
  } finally {
    await runtime.dispose();
  }
  assert.equal(closeCount, 1);
});

test("terminal settlement ignores late buffered lifecycle events", async () => {
  let closeCount = 0;
  const runtime = createScriptedRuntime(
    [
      { _tag: "RunStarted" },
      {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "first result" },
      },
      { _tag: "RunStarted" },
      {
        _tag: "RunSettled",
        outcome: { _tag: "Failed", errorText: "late failure" },
      },
    ],
    () => closeCount++,
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const settlements: string[] = [];
    manager.view.setOnSettled((snap) => settlements.push(snap.finalText));
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("scripted lifecycle")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    assert.equal(manager.view.get(snap.id)?.status, "done");
    assert.equal(manager.view.get(snap.id)?.finalText, "first result");
    assert.deepEqual(settlements, ["first result"]);
  } finally {
    await runtime.dispose();
  }
  assert.equal(closeCount, 1);
});

test("interruption is terminal even with a stale queued snapshot", async () => {
  let closeCount = 0;
  const runtime = createScriptedRuntime(
    [
      { _tag: "RunStarted" },
      {
        _tag: "QueueChanged",
        queued: [{ text: "stale follow-up", kind: "follow-up" }],
      },
      { _tag: "RunSettled", outcome: { _tag: "Interrupted" } },
    ],
    () => closeCount++,
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("scripted interrupt")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  } finally {
    await runtime.dispose();
  }
  assert.equal(closeCount, 1);
});

test("cancel force-settles a drain gap when interrupt returns no event", async () => {
  let closeCount = 0;
  const runtime = createNoopInterruptRuntime(() => closeCount++);

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("drain-gap cancellation")),
    );
    for (
      let attempt = 0;
      attempt < 100 && manager.view.get(snap.id)?.finalText !== "first result";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(snap.id)?.status, "running");

    await runTool(runtime, manager.cancel([snap.id]), {
      signal: AbortSignal.timeout(1_000),
      interruptMessage: "drain-gap cancellation timed out",
    });
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    assert.equal(manager.view.get(snap.id)?.finalText, "first result");
  } finally {
    await runtime.dispose();
  }
  assert.equal(closeCount, 1);
});

test("cancel preserves a backend's queued Interrupted partial text", async () => {
  let closeCount = 0;
  const runtime = createNoopInterruptRuntime(
    () => closeCount++,
    "partial work from child",
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("partial cancellation")),
    );
    for (
      let attempt = 0;
      attempt < 100 && manager.view.get(snap.id)?.finalText !== "first result";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await runTool(runtime, manager.cancel([snap.id]), {
      signal: AbortSignal.timeout(1_000),
      interruptMessage: "partial cancellation timed out",
    });
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    assert.equal(
      manager.view.get(snap.id)?.finalText,
      "partial work from child",
    );
  } finally {
    await runtime.dispose();
  }
  assert.equal(closeCount, 1);
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("settled subagents are closed and cannot restart", async () => {
  await withManager(async (manager, runtime) => {
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));

    assert.equal(manager.view.get(settled.id)?.status, "done");
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /finished and is closed/,
    );
    // The terminal snapshot remains available for result collection/history.
    assert.match(
      manager.view.get(settled.id)?.finalText ?? "",
      /early finisher/,
    );
  });
});

test("queued sends remain accepted while continuations drain before auto-close", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    for (
      let attempt = 0;
      attempt < 100 && (manager.view.get(snap.id)?.turns ?? 0) === 0;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runTool(runtime, manager.send(snap.id, "Second turn"));

    // The stub exposes a deliberate gap after the first RunSettled: the
    // manager remains logically running because Second turn is queued, while
    // the backend's current native turn is idle. A further send must queue,
    // not be dropped as an implicit restart.
    for (
      let attempt = 0;
      attempt < 200 &&
      !manager.view.get(snap.id)?.finalText.includes("First turn");
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(snap.id)?.status, "running");
    await runTool(runtime, manager.send(snap.id, "Third turn"));
    await runTool(runtime, manager.waitFor([snap.id]));

    const done = manager.view.get(snap.id);
    assert.equal(done?.status, "done");
    assert.match(done?.finalText ?? "", /Third turn/);
    await assert.rejects(
      runTool(runtime, manager.send(snap.id, "Fourth turn")),
      /finished and is closed/,
    );
  });
});
