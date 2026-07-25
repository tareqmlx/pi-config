import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearCommand(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Clear the terminal and start a new session",
    handler: async (_args, ctx) => {
      await ctx.newSession({
        withSession: async (ctx) => {
          ctx.ui.notify("New session started", "info");
        },
      });
    },
  });
}
