import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type EffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === value);
}

function getAvailableEffortLevels(model: ExtensionCommandContext["model"]) {
  return model ? getSupportedThinkingLevels(model) : [...EFFORT_LEVELS];
}

export function createEffortAutocompleteProvider(
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (
        !suggestions ||
        !textBeforeCursor.startsWith("/") ||
        textBeforeCursor.includes(" ")
      ) {
        return suggestions;
      }

      const items = suggestions.items.filter(
        (item) => item.value !== "thinking",
      );
      return items.length > 0 ? { ...suggestions, items } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

export default function effortCommand(pi: ExtensionAPI) {
  let completionLevels: readonly EffortLevel[] = EFFORT_LEVELS;

  pi.on("session_start", (_event, ctx) => {
    completionLevels = getAvailableEffortLevels(ctx.model);
    ctx.ui.addAutocompleteProvider((current) =>
      createEffortAutocompleteProvider(current),
    );
  });

  pi.on("model_select", (event) => {
    completionLevels = getSupportedThinkingLevels(event.model);
  });

  pi.registerCommand("effort", {
    description: "Set reasoning effort",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const levels = completionLevels.filter((level) =>
        level.startsWith(normalized),
      );
      return levels.length > 0
        ? levels.map((level) => ({ value: level, label: level }))
        : null;
    },
    handler: async (args, ctx) => {
      const availableLevels = getAvailableEffortLevels(ctx.model);
      let requested = args.trim().toLowerCase();

      if (!requested) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Usage: /effort <${availableLevels.join("|")}>`,
            "warning",
          );
          return;
        }

        requested =
          (await ctx.ui.select("Select reasoning effort", availableLevels)) ??
          "";
        if (!requested) return;
      }

      if (!isEffortLevel(requested) || !availableLevels.includes(requested)) {
        ctx.ui.notify(
          `Unknown effort "${requested}". Available levels: ${availableLevels.join(", ")}.`,
          "error",
        );
        return;
      }

      pi.setThinkingLevel(requested);
      ctx.ui.notify(`Reasoning effort: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
