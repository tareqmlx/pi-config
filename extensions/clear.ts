import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLEAR_SELECTION_ENTRY = "clear-model-selection";
const THINKING_LEVELS = new Set<unknown>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface ClearSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

function isClearSelection(value: unknown): value is ClearSelection {
  if (!value || typeof value !== "object") return false;

  return (
    "provider" in value &&
    typeof value.provider === "string" &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    "thinkingLevel" in value &&
    THINKING_LEVELS.has(value.thinkingLevel)
  );
}

export default function clearCommand(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;

    const selectionEntry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" && entry.customType === CLEAR_SELECTION_ENTRY,
      );
    if (
      !selectionEntry ||
      selectionEntry.type !== "custom" ||
      !isClearSelection(selectionEntry.data)
    ) {
      return;
    }

    const { provider, modelId, thinkingLevel } = selectionEntry.data;
    const model = ctx.modelRegistry.find(provider, modelId);
    let restored = false;
    if (model) {
      try {
        restored = await pi.setModel(model);
      } catch {
        // Authentication can change after the model registry snapshot is built.
      }
    }

    if (!restored) {
      ctx.ui.notify(
        `Could not restore model ${provider}/${modelId}`,
        "warning",
      );
      return;
    }

    pi.setThinkingLevel(thinkingLevel);
  });

  pi.registerCommand("clear", {
    description: "Clear the terminal and start a new session",
    handler: async (_args, ctx) => {
      const selection = ctx.model
        ? {
            provider: ctx.model.provider,
            modelId: ctx.model.id,
            thinkingLevel: pi.getThinkingLevel(),
          }
        : undefined;

      await ctx.newSession({
        setup: async (sessionManager) => {
          if (selection) {
            sessionManager.appendCustomEntry(CLEAR_SELECTION_ENTRY, selection);
          }
        },
        withSession: async (ctx) => {
          const model = ctx.model
            ? ` with ${ctx.model.provider}/${ctx.model.id}`
            : "";
          ctx.ui.notify(`New session started${model}`, "info");
        },
      });
    },
  });
}
