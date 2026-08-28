import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SUPPORTED_ACCOUNT_PROVIDERS = ["zai", "openai-codex"] as const;

export type AccountProvider = (typeof SUPPORTED_ACCOUNT_PROVIDERS)[number];

export interface AccountProfile {
  provider: AccountProvider;
  profile: string;
}

interface AccountConfig {
  version: 1;
  accounts: AccountProfile[];
}

interface MultiAccountOptions {
  configPath?: string;
}

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_CONFIG_NAME = "multi-account.json";
const PROVIDER_FACTORIES: Record<AccountProvider, () => Provider> = {
  zai: zaiProvider,
  "openai-codex": openaiCodexProvider,
};

function isAccountProvider(value: string): value is AccountProvider {
  return SUPPORTED_ACCOUNT_PROVIDERS.some((provider) => provider === value);
}

function parseAccount(value: unknown): AccountProfile {
  if (!value || typeof value !== "object") {
    throw new Error("Each account must be an object.");
  }

  const provider = Reflect.get(value, "provider");
  const profile = Reflect.get(value, "profile");
  if (typeof provider !== "string" || !isAccountProvider(provider)) {
    throw new Error(`Unsupported account provider: ${String(provider)}.`);
  }
  if (typeof profile !== "string" || !PROFILE_PATTERN.test(profile)) {
    throw new Error(`Invalid account profile: ${String(profile)}.`);
  }

  return { provider, profile };
}

function sortAccounts(accounts: readonly AccountProfile[]) {
  return [...accounts].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.profile.localeCompare(right.profile),
  );
}

export function readAccountConfig(configPath: string) {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The multi-account configuration must be an object.");
  }
  if (Reflect.get(parsed, "version") !== 1) {
    throw new Error("The multi-account configuration version must be 1.");
  }

  const accounts = Reflect.get(parsed, "accounts");
  if (!Array.isArray(accounts)) {
    throw new Error("The multi-account configuration needs an accounts array.");
  }

  const uniqueAccounts = new Map<string, AccountProfile>();
  for (const account of accounts.map(parseAccount)) {
    uniqueAccounts.set(accountProviderId(account), account);
  }
  return sortAccounts([...uniqueAccounts.values()]);
}

export function writeAccountConfig(
  configPath: string,
  accounts: readonly AccountProfile[],
) {
  const config: AccountConfig = {
    version: 1,
    accounts: sortAccounts(accounts),
  };
  mkdirSync(dirname(configPath), { recursive: true });

  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function accountProviderId(account: AccountProfile) {
  return `${account.provider}:${account.profile}`;
}

export function createAccountProvider(account: AccountProfile) {
  const base = PROVIDER_FACTORIES[account.provider]();
  const id = accountProviderId(account);

  return {
    ...base,
    id,
    name: `${base.name} (${account.profile})`,
    getModels: () =>
      base.getModels().map((model) => ({
        ...model,
        provider: id,
      })),
  } satisfies Provider;
}

function parseProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!isAccountProvider(normalized)) {
    throw new Error(
      `Unsupported provider "${value}". Use: ${SUPPORTED_ACCOUNT_PROVIDERS.join(", ")}.`,
    );
  }
  return normalized;
}

function parseProfile(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!PROFILE_PATTERN.test(normalized)) {
    throw new Error(
      "Profile names must start with a letter or number, contain only lowercase letters, numbers, underscores, or hyphens, and be at most 32 characters.",
    );
  }
  return normalized;
}

function usage() {
  return [
    "Usage:",
    "  /account add <zai|openai-codex> <profile>",
    "  /account list",
    "  /account remove <zai|openai-codex> <profile>",
  ].join("\n");
}

export function registerMultiAccountExtension(
  pi: ExtensionAPI,
  options: MultiAccountOptions = {},
) {
  const configPath =
    options.configPath ?? join(getAgentDir(), DEFAULT_CONFIG_NAME);
  let accounts: AccountProfile[] = [];
  let configError: Error | undefined;

  try {
    accounts = readAccountConfig(configPath);
    for (const account of accounts) {
      pi.registerProvider(createAccountProvider(account));
    }
  } catch (error) {
    configError =
      error instanceof Error
        ? error
        : new Error("Unknown configuration error.");
  }

  pi.on("session_start", (_event, ctx) => {
    if (configError) {
      ctx.ui.notify(
        `Could not load ${configPath}: ${configError.message}`,
        "error",
      );
    }
  });

  pi.registerCommand("account", {
    description: "Manage named ZAI and Codex accounts",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.trimStart().split(/\s+/);
      if (parts.length === 1) {
        const commands = ["add", "list", "remove"].filter((command) =>
          command.startsWith(parts[0] ?? ""),
        );
        return commands.length > 0
          ? commands.map((command) => ({ value: command, label: command }))
          : null;
      }

      if (parts.length === 2 && (parts[0] === "add" || parts[0] === "remove")) {
        const providers = SUPPORTED_ACCOUNT_PROVIDERS.filter((provider) =>
          provider.startsWith(parts[1] ?? ""),
        );
        return providers.length > 0
          ? providers.map((provider) => ({
              value: `${parts[0]} ${provider}`,
              label: provider,
            }))
          : null;
      }

      if (parts.length === 3 && parts[0] === "remove") {
        const provider = parts[1];
        const profiles = accounts.filter(
          (account) =>
            account.provider === provider &&
            account.profile.startsWith(parts[2] ?? ""),
        );
        return profiles.length > 0
          ? profiles.map((account) => ({
              value: `remove ${account.provider} ${account.profile}`,
              label: account.profile,
            }))
          : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      if (configError) {
        ctx.ui.notify(
          `Fix ${configPath} before changing accounts: ${configError.message}`,
          "error",
        );
        return;
      }

      const [command = "", providerInput = "", profileInput = "", ...rest] =
        args.trim().split(/\s+/).filter(Boolean);

      if (command === "list") {
        if (providerInput || profileInput || rest.length > 0) {
          ctx.ui.notify(usage(), "warning");
          return;
        }
        if (accounts.length === 0) {
          ctx.ui.notify(
            "No named accounts. Use /account add <provider> <profile>.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          accounts.map((account) => accountProviderId(account)).join("\n"),
          "info",
        );
        return;
      }

      if (command !== "add" && command !== "remove") {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      if (!providerInput || !profileInput || rest.length > 0) {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      let account: AccountProfile;
      try {
        account = {
          provider: parseProvider(providerInput),
          profile: parseProfile(profileInput),
        };
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Invalid account.",
          "error",
        );
        return;
      }

      const id = accountProviderId(account);
      const existingIndex = accounts.findIndex(
        (candidate) => accountProviderId(candidate) === id,
      );

      if (command === "add") {
        if (existingIndex >= 0) {
          ctx.ui.notify(`Account provider ${id} already exists.`, "warning");
          return;
        }

        const nextAccounts = sortAccounts([...accounts, account]);
        try {
          writeAccountConfig(configPath, nextAccounts);
          pi.registerProvider(createAccountProvider(account));
          accounts = nextAccounts;
        } catch (error) {
          ctx.ui.notify(
            `Could not add ${id}: ${error instanceof Error ? error.message : "unknown error"}`,
            "error",
          );
          return;
        }

        ctx.ui.notify(
          `Added ${id}. Run /login ${id} to authenticate it.`,
          "info",
        );
        return;
      }

      if (existingIndex < 0) {
        ctx.ui.notify(`Account provider ${id} does not exist.`, "warning");
        return;
      }
      if (ctx.model?.provider === id) {
        ctx.ui.notify(
          `Switch away from ${id} with /model before removing it.`,
          "warning",
        );
        return;
      }

      const nextAccounts = accounts.filter(
        (candidate) => accountProviderId(candidate) !== id,
      );
      try {
        writeAccountConfig(configPath, nextAccounts);
        pi.unregisterProvider(id);
        accounts = nextAccounts;
      } catch (error) {
        ctx.ui.notify(
          `Could not remove ${id}: ${error instanceof Error ? error.message : "unknown error"}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Removed ${id}. Its saved credential remains until you remove it with /logout.`,
        "info",
      );
    },
  });
}

export default function multiAccountExtension(pi: ExtensionAPI) {
  registerMultiAccountExtension(pi);
}
