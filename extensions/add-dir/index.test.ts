import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import addDirExtension, {
  buildAdditionalDirectoriesPrompt,
  completeDirectoryPaths,
  resolveDirectoryPath,
  splitCompletionPrefix,
} from "./index.ts";

test("resolveDirectoryPath validates and canonicalizes relative directory paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const directory = join(root, "frontend app");
  const file = join(root, "file.txt");
  await mkdir(directory);
  await writeFile(file, "not a directory");

  assert.equal(
    await resolveDirectoryPath('"frontend app"', root),
    await realpath(directory),
  );
  assert.equal(
    await resolveDirectoryPath('"frontend app', root),
    await realpath(directory),
  );
  await assert.rejects(
    resolveDirectoryPath("file.txt", root),
    /Not a directory: file\.txt/,
  );
  await assert.rejects(
    resolveDirectoryPath("missing", root),
    /Cannot access directory missing/,
  );
});

test("completeDirectoryPaths suggests directories and directory symlinks only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const parent = join(root, "projects");
  const frontend = join(parent, "frontend");
  await mkdir(frontend, { recursive: true });
  await mkdir(join(parent, "framework"));
  await writeFile(join(parent, "frozen.txt"), "file");
  await symlink(frontend, join(parent, "front-link"), "dir");

  const prefix = `projects${sep}fro`;
  const completions = await completeDirectoryPaths(prefix, root);

  assert.deepEqual(
    completions?.map(({ value }) => value),
    [`projects${sep}front-link${sep}`, `projects${sep}frontend${sep}`],
  );
  assert.ok(
    completions?.every(({ description }) => description?.startsWith(root)),
  );

  assert.deepEqual(
    (await completeDirectoryPaths(`"projects${sep}fro`, root))?.map(
      ({ value }) => value,
    ),
    [`projects${sep}front-link${sep}`, `projects${sep}frontend${sep}`],
  );

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.ok(
      (await completeDirectoryPaths("~", root))?.some(
        ({ value }) => value === `~${sep}projects${sep}`,
      ),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("splitCompletionPrefix accepts both Windows separator styles", () => {
  assert.deepEqual(splitCompletionPrefix("C:/work/fro", "win32"), {
    displayDirectory: "C:/work/",
    namePrefix: "fro",
    separator: "/",
  });
  assert.deepEqual(splitCompletionPrefix("C:\\work\\fro", "win32"), {
    displayDirectory: "C:\\work\\",
    namePrefix: "fro",
    separator: "\\",
  });
});

test("buildAdditionalDirectoriesPrompt keeps cwd primary and exposes added paths", () => {
  const prompt = buildAdditionalDirectoriesPrompt("/work/api", [
    "/work/frontend",
    "/work/shared",
  ]);

  assert.match(prompt, /Additional working directories/);
  assert.match(prompt, /"\/work\/frontend"/);
  assert.match(prompt, /"\/work\/shared"/);
  assert.match(prompt, /primary working directory remains "\/work\/api"/);
  assert.match(prompt, /absolute paths/);
  assert.match(prompt, /AGENTS\.md/);
  assert.equal(buildAdditionalDirectoriesPrompt("/work/api", []), "");
});

test("extension registers add-dir and injects its directory on the next turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontend = join(root, "frontend");
  const rejectedDirectory = join(root, "rejected");
  const cwdAlias = join(root, "api-link");
  await mkdir(frontend);
  await mkdir(rejectedDirectory);
  await symlink(root, cwdAlias, "dir");

  const handlers = new Map<string, (...args: never[]) => unknown>();
  let command:
    | {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => unknown;
      }
    | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  let appendError: Error | undefined;
  let branch: unknown[] = [];
  const api = {
    on: (event: string, handler: (...args: never[]) => unknown) =>
      handlers.set(event, handler),
    registerCommand: (
      name: string,
      value: {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => unknown;
      },
    ) => {
      assert.equal(name, "add-dir");
      command = value;
    },
    appendEntry: (customType: string, data: unknown) => {
      if (appendError) throw appendError;
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  addDirExtension(api);
  assert.ok(command?.getArgumentCompletions);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: cwdAlias,
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
  };

  await handlers.get("session_start")?.(
    { reason: "startup" } as never,
    ctx as never,
  );
  await command?.handler("frontend", ctx);

  const canonicalFrontend = await realpath(frontend);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.customType, "additional-working-directory");
  assert.deepEqual(notifications, [
    {
      message: `Added working directory: ${canonicalFrontend}`,
      level: "info",
    },
  ]);

  const result = handlers.get("before_agent_start")?.(
    { systemPrompt: "base prompt" } as never,
    ctx as never,
  ) as { systemPrompt: string };
  assert.match(result.systemPrompt, /^base prompt/);
  assert.match(
    result.systemPrompt,
    new RegExp(canonicalFrontend.replaceAll("\\", "\\\\")),
  );
  assert.match(
    result.systemPrompt,
    new RegExp(cwdAlias.replaceAll("\\", "\\\\")),
  );

  await command?.handler("frontend", ctx);
  assert.equal(appended.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /already added/i);

  const alternateFrontend = canonicalFrontend.toUpperCase();
  const [canonicalStat, alternateStat] = await Promise.all([
    stat(canonicalFrontend),
    stat(alternateFrontend).catch(() => undefined),
  ]);
  if (
    alternateStat &&
    canonicalFrontend !== alternateFrontend &&
    canonicalStat.dev === alternateStat.dev &&
    canonicalStat.ino === alternateStat.ino
  ) {
    await command?.handler(alternateFrontend, ctx);
    assert.equal(appended.length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /already added/i);
  }

  await command?.handler(".", ctx);
  assert.equal(appended.length, 1);
  assert.match(
    notifications.at(-1)?.message ?? "",
    /primary working directory/i,
  );

  appendError = new Error("session write failed");
  await command?.handler("rejected", ctx);
  assert.equal(appended.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /could not add/i);

  appendError = undefined;
  await command?.handler("rejected", ctx);
  assert.equal(appended.length, 2);
  assert.match(notifications.at(-1)?.message ?? "", /added working directory/i);

  const savedData = appended[0]?.data;
  assert.ok(savedData && typeof savedData === "object");
  branch = [
    {
      type: "custom",
      customType: "additional-working-directory",
      data: savedData,
    },
  ];

  await handlers.get("session_start")?.(
    { reason: "reload" } as never,
    ctx as never,
  );
  const restoredAfterReload = handlers.get("before_agent_start")?.(
    { systemPrompt: "base prompt" } as never,
    ctx as never,
  ) as { systemPrompt: string };
  assert.match(restoredAfterReload.systemPrompt, /frontend/);

  await handlers.get("session_start")?.(
    { reason: "resume" } as never,
    ctx as never,
  );
  assert.equal(
    handlers.get("before_agent_start")?.(
      { systemPrompt: "base prompt" } as never,
      ctx as never,
    ),
    undefined,
  );

  await handlers.get("session_start")?.(
    { reason: "fork" } as never,
    ctx as never,
  );
  const restoredAfterFork = handlers.get("before_agent_start")?.(
    { systemPrompt: "base prompt" } as never,
    ctx as never,
  ) as { systemPrompt: string };
  assert.match(restoredAfterFork.systemPrompt, /frontend/);

  branch = [
    {
      type: "custom",
      customType: "additional-working-directory",
      data: { ...savedData, processId: "different-process" },
    },
  ];
  await handlers.get("session_start")?.(
    { reason: "reload" } as never,
    ctx as never,
  );
  assert.equal(
    handlers.get("before_agent_start")?.(
      { systemPrompt: "base prompt" } as never,
      ctx as never,
    ),
    undefined,
  );
});
