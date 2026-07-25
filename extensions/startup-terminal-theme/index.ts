import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const QUERY_TIMEOUT_MS = 100;

export type TerminalColorScheme = "dark" | "light";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface TerminalThemeDetector {
  queryTerminalBackgroundColor(options: {
    timeoutMs: number;
  }): Promise<RgbColor | undefined>;
  queryTerminalColorScheme?(options: {
    timeoutMs: number;
  }): Promise<TerminalColorScheme | undefined>;
}

interface StartupThemes {
  dark: string;
  light: string;
}

interface StartupThemeProcessState {
  activeThemeName?: string;
}

declare global {
  var __piStartupTerminalThemeState__: StartupThemeProcessState | undefined;
}

function getProcessState() {
  return (globalThis.__piStartupTerminalThemeState__ ??= {});
}

export function shouldDetectTerminalTheme(reason: string, mode: string) {
  return reason === "startup" && mode === "tui";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStartupThemes(value: unknown) {
  if (!isRecord(value)) return undefined;

  const { dark, light } = value;
  if (typeof dark !== "string" || typeof light !== "string") return undefined;
  if (!dark.trim() || !light.trim()) return undefined;

  return { dark: dark.trim(), light: light.trim() } satisfies StartupThemes;
}

function toLinearChannel(channel: number) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function schemeForRgb({ r, g, b }: RgbColor): TerminalColorScheme {
  const luminance =
    0.2126 * toLinearChannel(r) +
    0.7152 * toLinearChannel(g) +
    0.0722 * toLinearChannel(b);
  return luminance >= 0.5 ? "light" : "dark";
}

function ansiColorToRgb(index: number): RgbColor | undefined {
  const baseColors: RgbColor[] = [
    { r: 0, g: 0, b: 0 },
    { r: 128, g: 0, b: 0 },
    { r: 0, g: 128, b: 0 },
    { r: 128, g: 128, b: 0 },
    { r: 0, g: 0, b: 128 },
    { r: 128, g: 0, b: 128 },
    { r: 0, g: 128, b: 128 },
    { r: 192, g: 192, b: 192 },
    { r: 128, g: 128, b: 128 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 255, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 0, b: 255 },
    { r: 0, g: 255, b: 255 },
    { r: 255, g: 255, b: 255 },
  ];

  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return baseColors[index];

  if (index < 232) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return {
      r: levels[Math.floor(offset / 36)]!,
      g: levels[Math.floor((offset % 36) / 6)]!,
      b: levels[offset % 6]!,
    };
  }

  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

export function schemeFromColorFgBg(value: string | undefined) {
  if (!value) return undefined;

  const backgroundIndex = [...value.split(";")]
    .reverse()
    .map((part) => Number.parseInt(part.trim(), 10))
    .find((index) => Number.isInteger(index) && index >= 0 && index <= 255);
  if (backgroundIndex === undefined) return undefined;

  const rgb = ansiColorToRgb(backgroundIndex);
  return rgb ? schemeForRgb(rgb) : undefined;
}

export async function detectTerminalColorScheme(
  detector: TerminalThemeDetector,
  colorFgBg = process.env.COLORFGBG,
) {
  // OSC 11 reports the terminal's actual background. Prefer it over the
  // color-scheme preference, which may follow the OS appearance even when a
  // terminal profile uses a fixed background of the opposite brightness.
  try {
    const background = await detector.queryTerminalBackgroundColor({
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    if (background) return schemeForRgb(background);
  } catch {
    // Fall through to the color-scheme preference.
  }

  try {
    const scheme = await detector.queryTerminalColorScheme?.({
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    if (scheme === "dark" || scheme === "light") return scheme;
  } catch {
    // Fall through to the environment hint.
  }

  return schemeFromColorFgBg(colorFgBg);
}

async function readStartupThemes() {
  const settingsPath = join(getAgentDir(), "settings.json");
  const content = await readFile(settingsPath, "utf8");
  const settings: unknown = JSON.parse(content);
  return parseStartupThemes(
    isRecord(settings) ? settings.startupThemes : undefined,
  );
}

function applyThemeWithoutPersisting(ctx: ExtensionContext, themeName: string) {
  const selectedTheme = ctx.ui.getTheme(themeName);
  if (!selectedTheme) {
    return { success: false, error: `Theme not found: ${themeName}` };
  }
  return ctx.ui.setTheme(selectedTheme);
}

export default function startupTerminalTheme(pi: ExtensionAPI) {
  const processState = getProcessState();

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "reload" || ctx.mode !== "tui") return;
    if (ctx.ui.theme.name) processState.activeThemeName = ctx.ui.theme.name;
  });

  pi.on("session_start", async (event, ctx) => {
    if (!shouldDetectTerminalTheme(event.reason, ctx.mode)) {
      if (
        event.reason === "reload" &&
        ctx.mode === "tui" &&
        processState.activeThemeName
      ) {
        const result = applyThemeWithoutPersisting(
          ctx,
          processState.activeThemeName,
        );
        if (!result.success) {
          ctx.ui.notify(
            `Could not restore startup theme ${processState.activeThemeName}: ${result.error ?? "unknown error"}`,
            "error",
          );
        }
      }
      return;
    }

    let startupThemes: StartupThemes | undefined;
    try {
      startupThemes = await readStartupThemes();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not read startupThemes: ${detail}`, "error");
      return;
    }

    if (!startupThemes) {
      ctx.ui.notify(
        "Set startupThemes.dark and startupThemes.light in settings.json to enable startup theme detection.",
        "warning",
      );
      return;
    }

    const unavailableTheme = [startupThemes.dark, startupThemes.light].find(
      (name) => !ctx.ui.getTheme(name),
    );
    if (unavailableTheme) {
      ctx.ui.notify(`Startup theme not found: ${unavailableTheme}`, "error");
      return;
    }

    // Terminal query methods are available only on the TUI passed to custom().
    // Calling done() before returning keeps the placeholder from ever mounting.
    const scheme = await ctx.ui.custom<TerminalColorScheme | undefined>(
      async (tui, _theme, _keybindings, done) => {
        done(await detectTerminalColorScheme(tui));
        return {
          invalidate() {},
          render() {
            return [];
          },
        };
      },
    );

    if (!scheme) {
      ctx.ui.notify(
        "Could not detect the terminal color scheme; keeping the configured theme.",
        "warning",
      );
      return;
    }

    const themeName = startupThemes[scheme];
    const result = applyThemeWithoutPersisting(ctx, themeName);
    if (!result.success) {
      ctx.ui.notify(
        `Could not apply startup theme ${themeName}: ${result.error ?? "unknown error"}`,
        "error",
      );
      return;
    }

    processState.activeThemeName = themeName;
  });
}
