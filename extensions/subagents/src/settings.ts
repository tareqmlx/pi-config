import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BACKEND_NAMES } from "./domain.ts";

export interface SubagentSettings {
  readonly enableClaudeSubagent: boolean;
}

const DEFAULT_SETTINGS: SubagentSettings = {
  enableClaudeSubagent: true,
};

/**
 * Read the extension's global setting directly from pi's settings file.
 * Missing, malformed, and non-boolean values preserve the backwards-compatible
 * default: Claude subagents remain enabled.
 */
export function loadSubagentSettings(agentDir = getAgentDir()) {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_SETTINGS;
    }
    const enableClaudeSubagent = Reflect.get(parsed, "enableClaudeSubagent");
    return {
      enableClaudeSubagent:
        typeof enableClaudeSubagent === "boolean"
          ? enableClaudeSubagent
          : DEFAULT_SETTINGS.enableClaudeSubagent,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function enabledBackendNames(settings: SubagentSettings) {
  return BACKEND_NAMES.filter(
    (name) => name !== "claude" || settings.enableClaudeSubagent,
  );
}
