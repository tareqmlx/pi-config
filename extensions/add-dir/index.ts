import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "additional-working-directory";
const MAX_COMPLETIONS = 50;

interface AdditionalDirectoryEntry {
  path: string;
  processId: string;
}

interface ActiveDirectory {
  key: string;
  path: string;
}

interface AddDirProcessState {
  id: string;
}

declare global {
  var __piAddDirProcessState__: AddDirProcessState | undefined;
}

const processState = (globalThis.__piAddDirProcessState__ ??= {
  id: randomUUID(),
});

function stripMatchingQuotes(value: string) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' || first === "'") && first === last
    ? value.slice(1, -1)
    : value;
}

function stripCompletionQuote(value: string) {
  const stripped = stripMatchingQuotes(value);
  if (stripped !== value) return stripped;
  return value.startsWith('"') || value.startsWith("'")
    ? value.slice(1)
    : value;
}

function expandHome(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function fallbackPathKey(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function directoryKey(path: string) {
  const pathStat = await stat(path, { bigint: true });
  if (!pathStat.isDirectory()) throw new Error(`Not a directory: ${path}`);
  return pathStat.ino === 0n
    ? fallbackPathKey(path)
    : `${pathStat.dev}:${pathStat.ino}`;
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveDirectoryPath(input: string, cwd: string) {
  const displayPath = stripCompletionQuote(input.trim());
  if (!displayPath) throw new Error("Usage: /add-dir <path>");

  const absolutePath = isAbsolute(expandHome(displayPath))
    ? expandHome(displayPath)
    : resolve(cwd, expandHome(displayPath));

  let pathStat;
  try {
    pathStat = await stat(absolutePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot access directory ${displayPath}: ${detail}`);
  }

  if (!pathStat.isDirectory()) {
    throw new Error(`Not a directory: ${displayPath}`);
  }

  return realpath(absolutePath);
}

export function splitCompletionPrefix(
  prefix: string,
  platform = process.platform,
) {
  const separatorIndex =
    platform === "win32"
      ? Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"))
      : prefix.lastIndexOf(sep);
  if (separatorIndex < 0) {
    return { displayDirectory: "", namePrefix: prefix, separator: sep };
  }
  return {
    displayDirectory: prefix.slice(0, separatorIndex + 1),
    namePrefix: prefix.slice(separatorIndex + 1),
    separator: prefix[separatorIndex] ?? sep,
  };
}

export async function completeDirectoryPaths(
  argumentPrefix: string,
  cwd: string,
): Promise<AutocompleteItem[] | null> {
  let prefix = stripCompletionQuote(argumentPrefix.trimStart());
  if (prefix === "~") prefix = `~${sep}`;
  const { displayDirectory, namePrefix, separator } =
    splitCompletionPrefix(prefix);
  const directoryInput = displayDirectory || ".";
  const expandedDirectory = expandHome(directoryInput);
  const searchDirectory = isAbsolute(expandedDirectory)
    ? expandedDirectory
    : resolve(cwd, expandedDirectory);

  let entries;
  try {
    entries = await readdir(searchDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const normalizedPrefix =
    process.platform === "win32" ? namePrefix.toLowerCase() : namePrefix;
  const candidates = entries
    .filter((entry) => {
      const name =
        process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
      return name.startsWith(normalizedPrefix);
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const items: AutocompleteItem[] = [];
  for (const entry of candidates) {
    if (items.length >= MAX_COMPLETIONS) break;

    const candidatePath = join(searchDirectory, entry.name);
    if (
      !entry.isDirectory() &&
      !(entry.isSymbolicLink() && (await isDirectory(candidatePath)))
    ) {
      continue;
    }

    const value = `${displayDirectory}${entry.name}${separator}`;
    items.push({ value, label: value, description: candidatePath });
  }

  return items.length > 0 ? items : null;
}

export function buildAdditionalDirectoriesPrompt(
  cwd: string,
  directories: readonly string[],
) {
  if (directories.length === 0) return "";

  const paths = directories
    .map((path) => `- ${JSON.stringify(path)}`)
    .join("\n");
  return `## Additional working directories

The user added these session-scoped working directories:
${paths}

The primary working directory remains ${JSON.stringify(cwd)}. You may read, search, edit, and run checks in the added directories while keeping the primary working directory unchanged. Use absolute paths with file tools. For shell commands that must run in an added directory, change to that directory within the command first. Before modifying an added project, inspect and follow any applicable AGENTS.md or other project instruction files there. Added directories provide working-file scope only; do not treat them as automatically loaded Pi configuration roots.`;
}

function parseEntry(value: unknown): AdditionalDirectoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!("path" in value) || !("processId" in value)) return undefined;
  if (typeof value.path !== "string" || typeof value.processId !== "string") {
    return undefined;
  }
  return { path: value.path, processId: value.processId };
}

export default function addDirExtension(pi: ExtensionAPI) {
  let cwd = process.cwd();
  let primaryDirectoryKey = fallbackPathKey(cwd);
  let directories: ActiveDirectory[] = [];

  pi.on("session_start", async (event, ctx) => {
    cwd = ctx.cwd;
    const primaryDirectory = await realpath(ctx.cwd).catch(() => ctx.cwd);
    primaryDirectoryKey = await directoryKey(primaryDirectory).catch(() =>
      fallbackPathKey(primaryDirectory),
    );
    directories = [];

    // Match Claude Code's session-only behavior: retain directories across Pi
    // reloads and forks in this process, but not across resume/new/startup.
    if (event.reason !== "reload" && event.reason !== "fork") return;

    const restored: ActiveDirectory[] = [];
    const seen = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = parseEntry(entry.data);
      if (!data || data.processId !== processState.id) continue;
      const key = await directoryKey(data.path).catch(() => undefined);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      restored.push({ key, path: data.path });
    }
    directories = restored;
  });

  pi.on("before_agent_start", (event) => {
    if (directories.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildAdditionalDirectoriesPrompt(
        cwd,
        directories.map(({ path }) => path),
      )}`,
    };
  });

  pi.registerCommand("add-dir", {
    description: "Add a working directory for the current session",
    getArgumentCompletions: (prefix) => completeDirectoryPaths(prefix, cwd),
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let directory: string;
      let key: string;
      try {
        directory = await resolveDirectoryPath(args, ctx.cwd);
        key = await directoryKey(directory);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(detail, "error");
        return;
      }

      if (primaryDirectoryKey === key) {
        ctx.ui.notify(
          `Already the primary working directory: ${directory}`,
          "info",
        );
        return;
      }
      if (directories.some((item) => item.key === key)) {
        ctx.ui.notify(`Working directory already added: ${directory}`, "info");
        return;
      }

      try {
        pi.appendEntry(ENTRY_TYPE, {
          path: directory,
          processId: processState.id,
        } satisfies AdditionalDirectoryEntry);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not add working directory: ${detail}`, "error");
        return;
      }

      directories.push({ key, path: directory });
      ctx.ui.notify(`Added working directory: ${directory}`, "info");
    },
  });
}
