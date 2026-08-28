import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import effortCommand, { createEffortAutocompleteProvider } from "./index.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type EffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

test("registers /effort and sets the selected level", async () => {
  let command: CommandOptions | undefined;
  let currentLevel: EffortLevel = "low";
  const notifications: string[] = [];
  const api = {
    on() {},
    registerCommand(name: string, options: CommandOptions) {
      assert.equal(name, "effort");
      command = options;
    },
    getThinkingLevel() {
      return currentLevel;
    },
    setThinkingLevel(level: EffortLevel) {
      currentLevel = level;
    },
  } as unknown as ExtensionAPI;

  effortCommand(api);
  assert.ok(command);

  const ctx = {
    model: undefined,
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;

  await command.handler("high", ctx);

  assert.equal(currentLevel, "high");
  assert.deepEqual(notifications, ["Reasoning effort: high"]);
});

test("offers effort levels as argument completions", () => {
  let command: CommandOptions | undefined;
  const api = {
    on() {},
    registerCommand(_name: string, options: CommandOptions) {
      command = options;
    },
  } as unknown as ExtensionAPI;

  effortCommand(api);
  assert.ok(command);

  assert.deepEqual(command.getArgumentCompletions?.("h"), [
    { value: "high", label: "high" },
  ]);
});

test("limits argument completions to levels supported by the active model", async () => {
  let command: CommandOptions | undefined;
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const api = {
    on(event: string, handler: (...args: never[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, options: CommandOptions) {
      command = options;
    },
  } as unknown as ExtensionAPI;

  effortCommand(api);
  assert.ok(command);

  await handlers.get("session_start")?.(
    {} as never,
    {
      model: { reasoning: false },
      ui: { addAutocompleteProvider() {} },
    } as never,
  );

  assert.deepEqual(command.getArgumentCompletions?.(""), [
    { value: "off", label: "off" },
  ]);
});

test("hides the built-in /thinking command from slash autocomplete", async () => {
  const current = {
    async getSuggestions() {
      return {
        prefix: "/",
        items: [
          { value: "thinking", label: "thinking" },
          { value: "effort", label: "effort" },
        ],
      };
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
      return { lines, cursorLine, cursorCol };
    },
  } satisfies AutocompleteProvider;
  const provider = createEffortAutocompleteProvider(current);

  const suggestions = await provider.getSuggestions(["/"], 0, 1, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(suggestions?.items, [{ value: "effort", label: "effort" }]);
});
