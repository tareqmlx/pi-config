import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  CustomEditor,
  getAgentDir,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";
import {
  IMAGE_ATTACHMENT_ENTRY,
  ImageAttachmentRegistry,
  ensureImageLabels,
  replaceImageLabels,
  type ImageAttachment,
} from "./src/image-attachments.ts";
import {
  PromptHistory,
  PromptHistoryReplayGuard,
} from "./src/prompt-history.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BLINKING_BEAM_CURSOR = "\x1b[5 q";
const DEFAULT_CURSOR = "\x1b[0 q";
const PROMPT_INDICATOR = "❯";
const PROMPT_INDICATOR_PADDING = 2;

export function addPromptIndicator(
  line: string,
  width: number,
  paddingX: number,
  color: (text: string) => string,
) {
  const renderedPadding = Math.min(
    paddingX,
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  if (renderedPadding === 0) return line;

  const indicator = truncateToWidth(
    `${color(PROMPT_INDICATOR)} `,
    renderedPadding,
    "",
  );
  const remainingPadding = Math.max(
    0,
    renderedPadding - visibleWidth(indicator),
  );
  return `${indicator}${" ".repeat(remainingPadding)}${line.slice(renderedPadding)}`;
}

export function addPromptIndicatorToEditor(
  lines: string[],
  width: number,
  paddingX: number,
  color: (text: string) => string,
) {
  const unscrolledTopBorder = color("─").repeat(width);
  if (lines[0] !== unscrolledTopBorder) return lines;

  return lines.map((line, index) =>
    index === 1 ? addPromptIndicator(line, width, paddingX, color) : line,
  );
}

class BeamCursorEditor extends CustomEditor {
  private promptHistory?: PromptHistory;
  private readonly replayGuard = new PromptHistoryReplayGuard();
  private transformInsertedText?: (text: string) => string;

  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    super.setPaddingX(PROMPT_INDICATOR_PADDING);
  }

  override setPaddingX(padding: number) {
    const basePadding = Number.isFinite(padding)
      ? Math.max(0, Math.floor(padding))
      : 0;
    super.setPaddingX(basePadding + PROMPT_INDICATOR_PADDING);
  }

  initializePromptHistory(
    promptHistory: PromptHistory,
    expectedReplay: string[],
  ) {
    this.promptHistory = promptHistory;
    this.expectHistoryReplay(expectedReplay);
    for (const prompt of promptHistory.values.reverse()) {
      super.addToHistory(prompt);
    }
  }

  expectHistoryReplay(prompts: string[]) {
    this.replayGuard.expect(prompts);
  }

  setInsertedTextTransform(transform: (text: string) => string) {
    this.transformInsertedText = transform;
  }

  override insertTextAtCursor(text: string) {
    super.insertTextAtCursor(this.transformInsertedText?.(text) ?? text);
  }

  override addToHistory(text: string) {
    const prompt = text.trim();
    if (!prompt || this.replayGuard.consume(prompt)) return;

    super.addToHistory(prompt);
    this.promptHistory?.record(prompt);
  }

  override render(width: number) {
    const lines = super
      .render(width)
      .map((line) => line.replace(`${CURSOR_MARKER}\x1b[7m`, CURSOR_MARKER));
    return addPromptIndicatorToEditor(
      lines,
      width,
      this.getPaddingX(),
      this.borderColor,
    );
  }
}
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function getUserPrompts(ctx: ExtensionContext) {
  return ctx.sessionManager
    .buildContextEntries()
    .flatMap(sessionEntryToContextMessages)
    .flatMap((message) => {
      if (message.role !== "user") return [];
      if (typeof message.content === "string") return [message.content];
      return [
        message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join(""),
      ];
    })
    .filter((prompt) => prompt.trim());
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  const imageAttachments = new ImageAttachmentRegistry();
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let activeEditor: BeamCursorEditor | undefined;
  let pendingTreeEditorText: string | undefined;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(
        setTimeout(() => {
          if (hideThemesSection(tui)) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function persistImageAttachment(
    ctx: ExtensionContext,
    attachment: ImageAttachment,
  ) {
    try {
      pi.appendEntry(
        IMAGE_ATTACHMENT_ENTRY,
        imageAttachments.registrationEntry(attachment),
      );
    } catch {
      ctx.ui.notify(
        `Could not persist metadata for ${attachment.label}`,
        "warning",
      );
    }
  }

  function install(ctx: ExtensionContext, populateHistoryAfterBind: boolean) {
    if (ctx.mode !== "tui") return;

    const promptHistory = new PromptHistory(
      join(getAgentDir(), "input-history.jsonl"),
      {
        project: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
      },
    );

    // Seed history for users upgrading from a version without persistent input
    // history. Later submissions are captured directly by BeamCursorEditor.
    if (promptHistory.values.length === 0) {
      for (const prompt of getUserPrompts(ctx)) promptHistory.record(prompt);
    }

    process.stdout.write(BLINKING_BEAM_CURSOR);
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeEditor = new BeamCursorEditor(tui, theme, keybindings);
      activeEditor.setInsertedTextTransform((text) => {
        imageAttachments.reserveIdsFromText(activeEditor?.getText() ?? "");
        const attachment = imageAttachments.registerClipboardPath(text);
        if (!attachment) return text;

        persistImageAttachment(ctx, attachment);
        return attachment.label;
      });
      activeEditor.initializePromptHistory(
        promptHistory,
        populateHistoryAfterBind ? getUserPrompts(ctx) : [],
      );
      return activeEditor;
    });

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";

          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            git += ` · ${linkedPr}`;
          }

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const contextWindow =
            modelInfo.contextWindow > 0
              ? formatTokens(modelInfo.contextWindow)
              : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const usage = `${contextPercent}%/${contextWindow} · $${modelInfo.cost.toFixed(2)} · ${tps}`;
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
            : modelInfo.modelId;

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), theme.fg("muted", git), width),
          ];

          // Extension statuses render after the two dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("input", async (event, ctx) => {
    if (
      event.source !== "interactive" ||
      !imageAttachments.hasPendingImages(event.text)
    ) {
      return { action: "continue" };
    }

    const prepared = await imageAttachments.preparePendingImages(event.text);
    for (const failure of prepared.failures) {
      ctx.ui.notify(
        `${failure.attachment.label} is unavailable: ${failure.reason}`,
        "warning",
      );
    }

    return {
      action: "transform",
      text: imageAttachments.annotateFailures(event.text, prepared.failures),
      images: [...(event.images ?? []), ...prepared.images],
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "user") return;
    let text =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("");
    const originalImages =
      typeof event.message.content === "string"
        ? []
        : event.message.content.filter((content) => content.type === "image");
    let transformed = false;
    const reconciled = imageAttachments.reconcilePreparedImages(
      text,
      originalImages,
    );
    if (reconciled.text !== text) {
      text = reconciled.text;
      transformed = true;
    }
    for (const attachment of reconciled.registrations) {
      persistImageAttachment(ctx, attachment);
    }
    const submittedIds = imageAttachments.markPreparedAsSubmitted(
      text,
      originalImages,
    );

    let fallbackImages: typeof originalImages = [];
    if (imageAttachments.hasPendingImages(text)) {
      const prepared = await imageAttachments.preparePendingImages(text);
      for (const failure of prepared.failures) {
        ctx.ui.notify(
          `${failure.attachment.label} is unavailable: ${failure.reason}`,
          "warning",
        );
      }
      text = imageAttachments.annotateFailures(text, prepared.failures);
      fallbackImages = prepared.images;
      submittedIds.push(
        ...imageAttachments.markPreparedAsSubmitted(text, fallbackImages),
      );
      transformed = fallbackImages.length > 0 || prepared.failures.length > 0;
    }

    const uniqueSubmittedIds = [...new Set(submittedIds)];
    const labeledText = ensureImageLabels(text, uniqueSubmittedIds);
    if (labeledText !== text) {
      text = labeledText;
      transformed = true;
    }
    if (uniqueSubmittedIds.length > 0) {
      pi.appendEntry(
        IMAGE_ATTACHMENT_ENTRY,
        imageAttachments.submittedEntry(uniqueSubmittedIds),
      );
    }

    if (!transformed) return;
    return {
      message: {
        ...event.message,
        content: [
          { type: "text" as const, text },
          ...originalImages,
          ...fallbackImages,
        ],
      },
    };
  });

  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "user") return message;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("");
      const hints = imageAttachments.localPathHints(text);
      if (hints.length === 0) return message;

      changed = true;
      const pathHint = {
        type: "text" as const,
        text: `\n<image-attachments>\n${hints.join("\n")}\n</image-attachments>`,
      };
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }, pathHint]
            : [...message.content, pathHint],
      };
    });

    return changed ? { messages } : undefined;
  });

  pi.on("session_before_tree", (event, ctx) => {
    pendingTreeEditorText = undefined;
    const preparedAttachments = imageAttachments.preparedAttachments();
    if (
      imageAttachments.isPreparingImages() ||
      (preparedAttachments.length > 0 && ctx.hasPendingMessages())
    ) {
      ctx.ui.notify(
        "Wait for images to load or dequeue them before navigating the session tree",
        "warning",
      );
      return { cancel: true };
    }
    for (const attachment of preparedAttachments) {
      imageAttachments.discardPreparedAttachment(attachment.id);
    }

    const target = ctx.sessionManager.getEntry(event.preparation.targetId);
    if (target?.type !== "message" || target.message.role !== "user") return;
    pendingTreeEditorText =
      typeof target.message.content === "string"
        ? target.message.content
        : target.message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("");
  });

  pi.on("session_start", (event, ctx) => {
    pendingTreeEditorText = undefined;
    imageAttachments.reset(ctx.sessionManager.getBranch());
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx, event.reason === "startup");
  });

  pi.on("session_tree", (_event, ctx) => {
    const currentEditorText = activeEditor?.getText() ?? "";
    const recalledEditorText =
      !currentEditorText.trim() && pendingTreeEditorText !== undefined;
    const editorText = currentEditorText.trim()
      ? currentEditorText
      : (pendingTreeEditorText ?? currentEditorText);
    pendingTreeEditorText = undefined;
    const previousDraftAttachments = currentEditorText.trim()
      ? imageAttachments.editorAttachments(currentEditorText)
      : [];
    imageAttachments.reset(ctx.sessionManager.getBranch(), true);
    const draftAttachments = currentEditorText.trim()
      ? previousDraftAttachments
      : imageAttachments.editorAttachments(editorText);

    const replacements = new Map<number, number>();
    for (const previous of draftAttachments) {
      const carried = imageAttachments.carryPendingAttachment(previous);
      if (!carried) continue;
      if (carried.shouldPersist) {
        persistImageAttachment(ctx, carried.attachment);
      }
      if (carried.attachment.id !== previous.id) {
        replacements.set(previous.id, carried.attachment.id);
      }
    }

    const reconciledText = replaceImageLabels(editorText, replacements);
    if (activeEditor && reconciledText !== currentEditorText) {
      activeEditor.setText(reconciledText);
      if (replacements.size > 0) {
        ctx.ui.notify(
          recalledEditorText
            ? "Recalled images were renumbered for this session branch"
            : "Renumbered pasted images to match the selected session branch",
          "info",
        );
      }
    }
    activeEditor?.expectHistoryReplay(getUserPrompts(ctx));
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    activeEditor = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      process.stdout.write(DEFAULT_CURSOR);
    }
  });
}
