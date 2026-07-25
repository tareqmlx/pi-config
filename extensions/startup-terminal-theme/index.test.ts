import assert from "node:assert/strict";
import test from "node:test";
import {
  detectTerminalColorScheme,
  parseStartupThemes,
  schemeFromColorFgBg,
  shouldDetectTerminalTheme,
} from "./index.ts";

test("parseStartupThemes accepts and trims both configured theme names", () => {
  assert.deepEqual(
    parseStartupThemes({
      dark: " github-dark-default ",
      light: " github-light-default ",
    }),
    {
      dark: "github-dark-default",
      light: "github-light-default",
    },
  );
});

test("parseStartupThemes rejects incomplete or non-object configuration", () => {
  assert.equal(parseStartupThemes({ dark: "github-dark-default" }), undefined);
  assert.equal(
    parseStartupThemes({ dark: "github-dark-default", light: " " }),
    undefined,
  );
  assert.equal(parseStartupThemes(null), undefined);
  assert.equal(parseStartupThemes([]), undefined);
  assert.equal(parseStartupThemes("github-dark-default"), undefined);
});

test("terminal detection is restricted to interactive process startup", () => {
  assert.equal(shouldDetectTerminalTheme("startup", "tui"), true);
  assert.equal(shouldDetectTerminalTheme("reload", "tui"), false);
  assert.equal(shouldDetectTerminalTheme("new", "tui"), false);
  assert.equal(shouldDetectTerminalTheme("resume", "tui"), false);
  assert.equal(shouldDetectTerminalTheme("fork", "tui"), false);
  assert.equal(shouldDetectTerminalTheme("startup", "rpc"), false);
  assert.equal(shouldDetectTerminalTheme("startup", "print"), false);
  assert.equal(shouldDetectTerminalTheme("startup", "json"), false);
});

test("schemeFromColorFgBg uses the final valid ANSI color as the background", () => {
  assert.equal(schemeFromColorFgBg("15;0"), "dark");
  assert.equal(schemeFromColorFgBg("0;15"), "light");
  assert.equal(schemeFromColorFgBg("0;16"), "dark");
  assert.equal(schemeFromColorFgBg("0;230"), "light");
  assert.equal(schemeFromColorFgBg("0;255"), "light");
  assert.equal(schemeFromColorFgBg("invalid"), undefined);
});

test("detectTerminalColorScheme prefers the actual background over the color-scheme preference", async () => {
  let colorSchemeQueries = 0;
  const detector = {
    async queryTerminalColorScheme() {
      colorSchemeQueries += 1;
      return "light" as const;
    },
    async queryTerminalBackgroundColor() {
      return { r: 0, g: 0, b: 0 };
    },
  };

  assert.equal(await detectTerminalColorScheme(detector, "0;15"), "dark");
  assert.equal(colorSchemeQueries, 0);
});

test("detectTerminalColorScheme falls back to OSC 11 background luminance", async () => {
  const lightDetector = {
    async queryTerminalColorScheme() {
      return undefined;
    },
    async queryTerminalBackgroundColor() {
      return { r: 250, g: 250, b: 250 };
    },
  };
  const darkDetector = {
    async queryTerminalColorScheme() {
      return undefined;
    },
    async queryTerminalBackgroundColor() {
      return { r: 20, g: 20, b: 20 };
    },
  };

  assert.equal(
    await detectTerminalColorScheme(lightDetector, undefined),
    "light",
  );
  assert.equal(
    await detectTerminalColorScheme(darkDetector, undefined),
    "dark",
  );
});

test("detectTerminalColorScheme falls back to the color-scheme preference", async () => {
  const detector = {
    async queryTerminalColorScheme() {
      return "light" as const;
    },
    async queryTerminalBackgroundColor() {
      return undefined;
    },
  };

  assert.equal(await detectTerminalColorScheme(detector, "15;0"), "light");
});

test("detectTerminalColorScheme falls back to COLORFGBG when terminal queries fail", async () => {
  const detector = {
    async queryTerminalColorScheme() {
      throw new Error("unsupported");
    },
    async queryTerminalBackgroundColor() {
      return undefined;
    },
  };

  assert.equal(await detectTerminalColorScheme(detector, "0;15"), "light");
});

test("detectTerminalColorScheme supports terminals without a color-scheme query", async () => {
  const detector = {
    async queryTerminalBackgroundColor() {
      return { r: 250, g: 250, b: 250 };
    },
  };

  assert.equal(await detectTerminalColorScheme(detector, undefined), "light");
});

test("detectTerminalColorScheme returns undefined when every signal is unavailable", async () => {
  const detector = {
    async queryTerminalBackgroundColor() {
      return undefined;
    },
  };

  assert.equal(await detectTerminalColorScheme(detector, undefined), undefined);
});
