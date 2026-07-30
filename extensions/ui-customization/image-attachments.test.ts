import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  IMAGE_ATTACHMENT_ENTRY,
  ImageAttachmentRegistry,
  ensureImageLabels,
  getClipboardImageMetadata,
  imageLabel,
  replaceImageLabels,
} from "./src/image-attachments.ts";

const FIRST_PATH = join(
  tmpdir(),
  "pi-clipboard-00000000-0000-4000-8000-000000000001.png",
);
const SECOND_PATH = join(
  tmpdir(),
  "pi-clipboard-00000000-0000-4000-8000-000000000002.jpg",
);

function customEntry(
  id: string,
  data:
    | ReturnType<ImageAttachmentRegistry["registrationEntry"]>
    | ReturnType<ImageAttachmentRegistry["submittedEntry"]>,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: IMAGE_ATTACHMENT_ENTRY,
    data,
  };
}

function userEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: "user-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  };
}

function imageLoader() {
  return async (attachment: { id: number; mimeType: string }) => ({
    type: "image" as const,
    data: `image-${attachment.id}`,
    mimeType: attachment.mimeType,
  });
}

test("recognizes only Pi-generated clipboard image paths", () => {
  assert.deepEqual(getClipboardImageMetadata(FIRST_PATH), {
    path: FIRST_PATH,
    mimeType: "image/png",
  });
  assert.deepEqual(getClipboardImageMetadata(SECOND_PATH), {
    path: SECOND_PATH,
    mimeType: "image/jpeg",
  });
  assert.equal(
    getClipboardImageMetadata(join(tmpdir(), "ordinary-image.png")),
    undefined,
  );
  assert.equal(
    getClipboardImageMetadata(
      "/not-the-system-temp/pi-clipboard-00000000-0000-4000-8000-000000000001.png",
    ),
    undefined,
  );
});

test("assigns session-local image labels in insertion order", () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  const first = registry.registerClipboardPath(FIRST_PATH);
  const second = registry.registerClipboardPath(SECOND_PATH);

  assert.equal(first?.label, "[Image #1]");
  assert.equal(second?.label, "[Image #2]");
  assert.equal(registry.registerClipboardPath("some normal text"), undefined);
});

test("reserves image ids already typed in the unsent editor", () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.reserveIdsFromText("literal [Image #1] and [Image #4]");

  assert.equal(registry.registerClipboardPath(FIRST_PATH)?.label, "[Image #5]");
});

test("seeds numbering from active session labels", () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.reset([userEntry("Earlier [Image #8]")]);

  assert.equal(registry.registerClipboardPath(FIRST_PATH)?.label, "[Image #9]");
});

test("prepares referenced pending images in marker order without duplicates", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.registerClipboardPath(FIRST_PATH);
  registry.registerClipboardPath(SECOND_PATH);

  const prepared = await registry.preparePendingImages(
    "compare [Image #2], [Image #1], and [Image #2] again",
  );

  assert.deepEqual(
    prepared.images.map((image) => image.data),
    ["image-2", "image-1"],
  );
  assert.deepEqual(prepared.attachmentIds, [2, 1]);
  assert.deepEqual(prepared.failures, []);
});

test("does not attach an image again after its user message is finalized", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.registerClipboardPath(FIRST_PATH);
  await registry.preparePendingImages("inspect [Image #1]");

  assert.deepEqual(registry.markPreparedAsSubmitted("inspect [Image #1]"), [1]);
  assert.equal(registry.hasPendingImages("inspect [Image #1] again"), false);
  assert.deepEqual(
    await registry.preparePendingImages("inspect [Image #1] again"),
    { images: [], attachmentIds: [], failures: [] },
  );
});

test("finalizes prepared images when prompt expansion removes their labels", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.registerClipboardPath(FIRST_PATH);
  const prepared = await registry.preparePendingImages("/template [Image #1]");

  assert.deepEqual(
    registry.markPreparedAsSubmitted(
      "expanded template without a label",
      prepared.images,
    ),
    [1],
  );
  assert.equal(registry.hasPendingImages("reference [Image #1]"), false);
});

test("restores model-only path hints when expansion removes image labels", async () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  const attachment = source.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);
  const prepared = await source.preparePendingImages("template [Image #1]");
  const submittedIds = source.markPreparedAsSubmitted(
    "expanded without label",
    prepared.images,
  );
  const labeledText = ensureImageLabels("expanded without label", submittedIds);

  const restored = new ImageAttachmentRegistry(imageLoader());
  restored.reset([
    customEntry("registered", source.registrationEntry(attachment)),
    customEntry("submitted", source.submittedEntry([attachment.id])),
  ]);

  assert.equal(labeledText, "expanded without label\n[Image #1]");
  assert.deepEqual(restored.localPathHints(labeledText), [
    `${imageLabel(1)}: ${FIRST_PATH}`,
  ]);
});

test("keeps distinct labels and paths for identical image payloads", async () => {
  const registry = new ImageAttachmentRegistry(async (attachment) => ({
    type: "image",
    data: "identical-image-bytes",
    mimeType: attachment.mimeType,
  }));
  registry.registerClipboardPath(FIRST_PATH);
  registry.registerClipboardPath(SECOND_PATH);
  const prepared = await registry.preparePendingImages("[Image #1] [Image #2]");
  const submittedIds = registry.markPreparedAsSubmitted("", prepared.images);
  const labeledText = ensureImageLabels("", submittedIds);

  assert.equal(labeledText, "[Image #1] [Image #2]");
  assert.deepEqual(registry.localPathHints(labeledText), [
    `${imageLabel(1)}: ${FIRST_PATH}`,
    `${imageLabel(2)}: ${SECOND_PATH}`,
  ]);
});

test("drops image preparation results when the session changes during loading", async () => {
  let release: (() => void) | undefined;
  const registry = new ImageAttachmentRegistry(async (attachment) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      type: "image",
      data: `image-${attachment.id}`,
      mimeType: attachment.mimeType,
    };
  });
  registry.registerClipboardPath(FIRST_PATH);

  const preparing = registry.preparePendingImages("queued [Image #1]");
  assert.equal(registry.isPreparingImages(), true);
  registry.reset([], true);
  assert.ok(release);
  release();
  const prepared = await preparing;

  assert.equal(registry.isPreparingImages(), false);
  assert.deepEqual(prepared.images, []);
  assert.equal(
    prepared.failures[0]?.reason,
    "the session changed while the image was loading",
  );
  assert.deepEqual(
    registry.markPreparedAsSubmitted("queued [Image #1]", prepared.images),
    [],
  );
});

test("does not let a stale rejected load hide the target branch path", async () => {
  let rejectLoad: (() => void) | undefined;
  const registry = new ImageAttachmentRegistry(
    () =>
      new Promise((_, reject) => {
        rejectLoad = () => reject(new Error("old file disappeared"));
      }),
  );
  registry.registerClipboardPath(FIRST_PATH);
  const preparing = registry.preparePendingImages("queued [Image #1]");

  const target = new ImageAttachmentRegistry(imageLoader());
  const attachment = target.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);
  registry.reset(
    [customEntry("target", target.registrationEntry(attachment))],
    true,
  );
  assert.ok(rejectLoad);
  rejectLoad();
  const prepared = await preparing;

  assert.equal(
    prepared.failures[0]?.reason,
    "the session changed while the image was loading",
  );
  assert.deepEqual(registry.localPathHints("target [Image #1]"), [
    `${imageLabel(1)}: ${FIRST_PATH}`,
  ]);
});

test("downgrades dequeued prepared images back to pending drafts", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.registerClipboardPath(FIRST_PATH);
  await registry.preparePendingImages("queued [Image #1]");

  registry.discardPreparedAttachment(1);

  assert.deepEqual(registry.preparedAttachments(), []);
  assert.equal(registry.hasPendingImages("restored [Image #1]"), true);
});

test("treats attached image identity as authoritative after prepared state is cleared", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  const attachment = registry.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);
  const prepared = await registry.preparePendingImages("queued [Image #1]");

  registry.reset(
    [customEntry("registered", registry.registrationEntry(attachment))],
    true,
  );
  registry.discardPreparedAttachment(attachment.id);

  assert.deepEqual(
    registry.markPreparedAsSubmitted("expanded without label", prepared.images),
    [1],
  );
  assert.equal(registry.hasPendingImages("[Image #1]"), false);
});

test("reconciles an attached image after preflight navigation changes its id", async () => {
  const registry = new ImageAttachmentRegistry(imageLoader());
  const attachment = registry.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);
  const prepared = await registry.preparePendingImages("send [Image #1]");
  registry.discardPreparedAttachment(attachment.id);

  const target = new ImageAttachmentRegistry(imageLoader());
  const conflicting = target.registerClipboardPath(SECOND_PATH);
  assert.ok(conflicting);
  registry.reset(
    [customEntry("target", target.registrationEntry(conflicting))],
    true,
  );
  const reconciled = registry.reconcilePreparedImages(
    "send [Image #1]",
    prepared.images,
  );

  assert.equal(reconciled.text, "send [Image #2]");
  assert.equal(reconciled.registrations[0]?.path, FIRST_PATH);
  assert.deepEqual(
    registry.markPreparedAsSubmitted(reconciled.text, prepared.images),
    [2],
  );
  assert.deepEqual(registry.localPathHints(reconciled.text), [
    `${imageLabel(2)}: ${FIRST_PATH}`,
  ]);
});

test("carries unsent attachments across a session-tree reset", () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  const attachment = source.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);

  const target = new ImageAttachmentRegistry(imageLoader());
  target.reset([]);
  const carried = target.carryPendingAttachment(attachment);

  assert.equal(carried?.attachment.label, "[Image #1]");
  assert.equal(carried?.shouldPersist, true);
  assert.equal(target.hasPendingImages("draft [Image #1]"), true);
});

test("carries recalled submitted image labels onto a new branch", async () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  const attachment = source.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);
  const prepared = await source.preparePendingImages("inspect [Image #1]");
  source.markPreparedAsSubmitted("inspect [Image #1]", prepared.images);

  assert.deepEqual(source.pendingAttachments("inspect [Image #1]"), []);
  const recalled = source.editorAttachments("inspect [Image #1]");
  assert.deepEqual(
    recalled.map((item) => item.id),
    [1],
  );

  const target = new ImageAttachmentRegistry(imageLoader());
  target.reset([
    customEntry("registered", source.registrationEntry(attachment)),
    customEntry("submitted", source.submittedEntry([attachment.id])),
  ]);
  const carried = target.carryPendingAttachment(recalled[0]!);

  assert.equal(carried?.attachment.label, "[Image #2]");
  assert.equal(target.hasPendingImages("inspect [Image #2]"), true);
});

test("renumbers a carried draft attachment when its id exists on the target branch", () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  const attachment = source.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);

  const target = new ImageAttachmentRegistry(imageLoader());
  target.reset([userEntry("historical [Image #1]")]);
  const carried = target.carryPendingAttachment(attachment);

  assert.equal(carried?.attachment.label, "[Image #2]");
  assert.equal(target.hasPendingImages("draft [Image #2]"), true);
});

test("renumbers multiple carried draft labels without clobbering siblings", () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  source.registerClipboardPath(FIRST_PATH);
  source.registerClipboardPath(SECOND_PATH);
  const draft = "compare [Image #1] with [Image #2]";

  const conflictSource = new ImageAttachmentRegistry(imageLoader());
  const conflicting = conflictSource.registerClipboardPath(SECOND_PATH);
  assert.ok(conflicting);

  const target = new ImageAttachmentRegistry(imageLoader());
  target.reset([
    customEntry("conflict", conflictSource.registrationEntry(conflicting)),
  ]);
  const replacements = new Map<number, number>();
  for (const previous of source.pendingAttachments(draft)) {
    const carried = target.carryPendingAttachment(previous);
    assert.ok(carried);
    replacements.set(previous.id, carried.attachment.id);
  }

  assert.equal(
    replaceImageLabels(draft, replacements),
    "compare [Image #2] with [Image #3]",
  );
});

test("restores registered and submitted attachment state", () => {
  const source = new ImageAttachmentRegistry(imageLoader());
  const attachment = source.registerClipboardPath(FIRST_PATH);
  assert.ok(attachment);

  const registry = new ImageAttachmentRegistry(imageLoader());
  registry.reset([
    customEntry("registered", source.registrationEntry(attachment)),
    customEntry("submitted", source.submittedEntry([attachment.id])),
  ]);

  assert.equal(registry.hasPendingImages("again [Image #1]"), false);
  assert.deepEqual(registry.localPathHints("again [Image #1]"), [
    `${imageLabel(1)}: ${FIRST_PATH}`,
  ]);
  assert.equal(
    registry.registerClipboardPath(SECOND_PATH)?.label,
    "[Image #2]",
  );
});

test("annotates unavailable images and omits their local path hints", async () => {
  const registry = new ImageAttachmentRegistry(async () => {
    throw new Error("file disappeared");
  });
  registry.registerClipboardPath(FIRST_PATH);

  const prepared = await registry.preparePendingImages("inspect [Image #1]");

  assert.equal(prepared.images.length, 0);
  assert.equal(prepared.failures[0]?.reason, "file disappeared");
  assert.equal(
    registry.annotateFailures("inspect [Image #1]", prepared.failures),
    "inspect [Image #1 unavailable]",
  );
  assert.deepEqual(registry.localPathHints("inspect [Image #1]"), []);
});
