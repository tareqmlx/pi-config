import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { addPromptIndicator, addPromptIndicatorToEditor } from "./index.ts";

const identity = (text: string) => text;

test("adds a Claude-style prompt indicator without changing line width", () => {
  const line = "  prompt";
  const decorated = addPromptIndicator(line, 80, 2, identity);

  assert.equal(decorated, "❯ prompt");
  assert.equal(visibleWidth(decorated), visibleWidth(line));
});

test("preserves editor padding beyond the prompt indicator", () => {
  assert.equal(addPromptIndicator("    prompt", 80, 4, identity), "❯   prompt");
});

test("fits the indicator to narrow editor widths", () => {
  const decorated = addPromptIndicator(" prompt", 3, 2, identity);

  assert.equal(decorated.replace("\x1b[0m", ""), "❯prompt");
  assert.equal(visibleWidth(decorated), visibleWidth(" prompt"));
  assert.equal(addPromptIndicator("prompt", 2, 2, identity), "prompt");
});

test("adds the indicator when the unscrolled top border is visible", () => {
  const lines = ["───────────", "  prompt", "───────────"];

  assert.deepEqual(addPromptIndicatorToEditor(lines, 11, 2, identity), [
    "───────────",
    "❯ prompt",
    "───────────",
  ]);
});

test("does not add the indicator when a narrow scroll border omits its arrow", () => {
  const lines = ["─── ...", " continuation", "───────"];

  assert.deepEqual(addPromptIndicatorToEditor(lines, 7, 2, identity), lines);
});
