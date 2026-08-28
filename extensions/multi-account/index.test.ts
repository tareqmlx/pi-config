import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  accountProviderId,
  createAccountProvider,
  readAccountConfig,
  registerMultiAccountExtension,
  writeAccountConfig,
  type AccountProfile,
} from "./index.ts";

interface RegisteredCommand {
  handler: (args: string, ctx: CommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

interface CommandContext {
  model?: { provider: string };
  ui: {
    notify(message: string, level: string): void;
  };
}

function createTestApi() {
  const providers: Provider[] = [];
  const removedProviders: string[] = [];
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<string, (...args: never[]) => unknown>();

  const api = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      eventHandlers.set(event, handler);
    },
    registerProvider: (provider: Provider) => {
      providers.push(provider);
    },
    unregisterProvider: (provider: string) => {
      removedProviders.push(provider);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  return { api, commands, eventHandlers, providers, removedProviders };
}

function createCommandContext() {
  const notifications: Array<{ message: string; level: string }> = [];
  const context: CommandContext = {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
  return { context, notifications };
}

test("accountProviderId creates a provider-scoped profile id", () => {
  assert.equal(
    accountProviderId({ provider: "openai-codex", profile: "work" }),
    "openai-codex:work",
  );
});

test("createAccountProvider keeps native auth and assigns models to the profile provider", () => {
  const personal = createAccountProvider({
    provider: "zai",
    profile: "personal",
  });
  const work = createAccountProvider({ provider: "zai", profile: "work" });

  assert.equal(personal.id, "zai:personal");
  assert.equal(personal.name, "Z.AI (personal)");
  assert.ok(personal.auth.apiKey);
  assert.notEqual(personal.id, work.id);
  assert.ok(personal.getModels().length > 0);
  assert.ok(
    personal.getModels().every((model) => model.provider === "zai:personal"),
  );

  const codex = createAccountProvider({
    provider: "openai-codex",
    profile: "work",
  });
  assert.equal(codex.id, "openai-codex:work");
  assert.equal(codex.name, "OpenAI Codex (work)");
  assert.ok(codex.auth.oauth);
  assert.ok(
    codex.getModels().every((model) => model.provider === "openai-codex:work"),
  );
});

test("account configuration round-trips in stable order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-multi-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "multi-account.json");
  const accounts: AccountProfile[] = [
    { provider: "zai", profile: "work" },
    { provider: "openai-codex", profile: "personal" },
  ];

  writeAccountConfig(configPath, accounts);

  assert.deepEqual(readAccountConfig(configPath), [
    { provider: "openai-codex", profile: "personal" },
    { provider: "zai", profile: "work" },
  ]);
  const onDisk = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(onDisk.version, 1);
});

test("invalid account configuration is rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-multi-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "multi-account.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      accounts: [{ provider: "zai", profile: "Work Account" }],
    }),
  );

  assert.throws(() => readAccountConfig(configPath), /Invalid account profile/);
});

test("account command adds, lists, and removes profile providers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-multi-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "multi-account.json");
  const { api, commands, providers, removedProviders } = createTestApi();
  const { context, notifications } = createCommandContext();

  registerMultiAccountExtension(api, { configPath });
  const command = commands.get("account");
  assert.ok(command);
  assert.ok(command.getArgumentCompletions);

  await command.handler("add zai Personal", context);
  assert.equal(providers.at(-1)?.id, "zai:personal");
  assert.deepEqual(readAccountConfig(configPath), [
    { provider: "zai", profile: "personal" },
  ]);
  assert.match(notifications.at(-1)?.message ?? "", /\/login zai:personal/);

  await command.handler("add zai personal", context);
  assert.match(notifications.at(-1)?.message ?? "", /already exists/);
  assert.equal(providers.length, 1);

  await command.handler("list", context);
  assert.equal(notifications.at(-1)?.message, "zai:personal");

  context.model = { provider: "zai:personal" };
  await command.handler("remove zai personal", context);
  assert.match(notifications.at(-1)?.message ?? "", /Switch away/);
  assert.equal(removedProviders.length, 0);

  context.model = { provider: "zai" };
  await command.handler("remove zai personal", context);
  assert.deepEqual(removedProviders, ["zai:personal"]);
  assert.deepEqual(readAccountConfig(configPath), []);
  assert.match(notifications.at(-1)?.message ?? "", /credential remains/);
});

test("configured accounts register during extension startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-multi-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "multi-account.json");
  writeAccountConfig(configPath, [
    { provider: "openai-codex", profile: "personal" },
    { provider: "openai-codex", profile: "work" },
  ]);
  const { api, providers } = createTestApi();

  registerMultiAccountExtension(api, { configPath });

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["openai-codex:personal", "openai-codex:work"],
  );
});
