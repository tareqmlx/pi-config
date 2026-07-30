import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import {
  resizeImage,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

export const IMAGE_ATTACHMENT_ENTRY = "ui-customization.image-attachment";

const IMAGE_MARKER_PATTERN = /\[Image #(\d+)\]/g;
const CLIPBOARD_IMAGE_PATTERN =
  /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|gif|webp)$/i;

const MIME_TYPES = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
} as const;

export interface ImageAttachment {
  id: number;
  label: string;
  path: string;
  mimeType: string;
}

interface RegisteredAttachmentEntry {
  kind: "registered";
  id: number;
  path: string;
  mimeType: string;
}

interface SubmittedAttachmentsEntry {
  kind: "submitted";
  ids: number[];
}

export type ImageAttachmentEntryData =
  RegisteredAttachmentEntry | SubmittedAttachmentsEntry;

interface PreparedImage {
  attachment: ImageAttachment;
  image: ImageContent;
}

export interface ImagePreparationFailure {
  attachment: ImageAttachment;
  reason: string;
}

export interface PreparedImages {
  images: ImageContent[];
  attachmentIds: number[];
  failures: ImagePreparationFailure[];
}

type ImageLoader = (attachment: ImageAttachment) => Promise<ImageContent>;

export function imageLabel(id: number) {
  return `[Image #${id}]`;
}

export function replaceImageLabels(
  text: string,
  replacements: ReadonlyMap<number, number>,
) {
  return text.replace(/\[Image #(\d+)\]/g, (marker, rawId: string) => {
    const replacement = replacements.get(Number(rawId));
    return replacement === undefined ? marker : imageLabel(replacement);
  });
}

export function ensureImageLabels(text: string, ids: number[]) {
  const existingIds = new Set(markerIds(text));
  const missingLabels = [...new Set(ids)]
    .filter((id) => !existingIds.has(id))
    .map(imageLabel);
  if (missingLabels.length === 0) return text;
  return `${text}${text ? "\n" : ""}${missingLabels.join(" ")}`;
}

function mimeTypeForPath(path: string) {
  const extension = extname(path).toLowerCase() as keyof typeof MIME_TYPES;
  return MIME_TYPES[extension];
}

export function getClipboardImageMetadata(path: string) {
  if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(tmpdir())) {
    return undefined;
  }

  if (!CLIPBOARD_IMAGE_PATTERN.test(basename(path))) return undefined;
  const mimeType = mimeTypeForPath(path);
  return mimeType ? { path, mimeType } : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseEntryData(value: unknown): ImageAttachmentEntryData | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return undefined;
  }

  if (value.kind === "registered") {
    if (
      !("id" in value) ||
      !isPositiveInteger(value.id) ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("mimeType" in value) ||
      typeof value.mimeType !== "string"
    ) {
      return undefined;
    }

    const metadata = getClipboardImageMetadata(value.path);
    if (!metadata || metadata.mimeType !== value.mimeType) return undefined;
    return {
      kind: "registered",
      id: value.id,
      path: metadata.path,
      mimeType: metadata.mimeType,
    };
  }

  if (value.kind === "submitted") {
    if (
      !("ids" in value) ||
      !Array.isArray(value.ids) ||
      !value.ids.every(isPositiveInteger)
    ) {
      return undefined;
    }

    return { kind: "submitted", ids: [...new Set(value.ids)] };
  }

  return undefined;
}

function markerIds(text: string) {
  return [...text.matchAll(IMAGE_MARKER_PATTERN)]
    .map((match) => Number(match[1]))
    .filter(isPositiveInteger);
}

function textFromSessionEntry(entry: SessionEntry) {
  if (entry.type !== "message" || entry.message.role !== "user") return "";
  if (typeof entry.message.content === "string") return entry.message.content;
  return entry.message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

async function loadImage(attachment: ImageAttachment) {
  const bytes = await readFile(attachment.path);
  const resized = await resizeImage(bytes, attachment.mimeType);
  if (!resized) {
    throw new Error("could not resize the image below the inline size limit");
  }

  return {
    type: "image",
    data: resized.data,
    mimeType: resized.mimeType,
  } satisfies ImageContent;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class ImageAttachmentRegistry {
  private readonly attachments = new Map<number, ImageAttachment>();
  private preparedImageAttachments = new WeakMap<
    ImageContent,
    ImageAttachment
  >();
  private readonly preparedIds = new Set<number>();
  private readonly submittedIds = new Set<number>();
  private readonly unavailableIds = new Set<number>();
  private readonly usedIds = new Set<number>();
  private readonly loader: ImageLoader;
  private activePreparations = 0;
  private generation = 0;
  private nextId = 1;

  constructor(loader: ImageLoader = loadImage) {
    this.loader = loader;
  }

  reset(entries: SessionEntry[] = [], preservePrepared = false) {
    this.generation += 1;
    this.attachments.clear();
    if (!preservePrepared) {
      this.preparedImageAttachments = new WeakMap();
      this.preparedIds.clear();
    }
    this.submittedIds.clear();
    this.unavailableIds.clear();
    this.usedIds.clear();
    this.nextId = 1;

    for (const entry of entries) {
      for (const id of markerIds(textFromSessionEntry(entry))) {
        this.usedIds.add(id);
        this.nextId = Math.max(this.nextId, id + 1);
      }

      if (
        entry.type !== "custom" ||
        entry.customType !== IMAGE_ATTACHMENT_ENTRY
      ) {
        continue;
      }

      const data = parseEntryData(entry.data);
      if (!data) continue;

      if (data.kind === "submitted") {
        for (const id of data.ids) {
          this.submittedIds.add(id);
          this.usedIds.add(id);
        }
        continue;
      }

      const attachment = {
        id: data.id,
        label: imageLabel(data.id),
        path: data.path,
        mimeType: data.mimeType,
      } satisfies ImageAttachment;
      this.attachments.set(attachment.id, attachment);
      this.usedIds.add(attachment.id);
      this.nextId = Math.max(this.nextId, attachment.id + 1);
    }
  }

  reserveIdsFromText(text: string) {
    for (const id of markerIds(text)) {
      this.usedIds.add(id);
      this.nextId = Math.max(this.nextId, id + 1);
    }
  }

  registerClipboardPath(path: string) {
    const metadata = getClipboardImageMetadata(path);
    if (!metadata) return undefined;

    while (this.usedIds.has(this.nextId)) this.nextId += 1;
    const id = this.nextId;
    this.nextId += 1;
    const attachment = {
      id,
      label: imageLabel(id),
      path: metadata.path,
      mimeType: metadata.mimeType,
    } satisfies ImageAttachment;
    this.attachments.set(id, attachment);
    this.usedIds.add(id);
    return attachment;
  }

  pendingAttachments(text: string) {
    return this.referencedAttachments(text, true);
  }

  editorAttachments(text: string) {
    return this.referencedAttachments(text, false);
  }

  isPreparingImages() {
    return this.activePreparations > 0;
  }

  preparedAttachments() {
    return [...this.preparedIds].flatMap((id) => {
      const attachment = this.attachments.get(id);
      return attachment ? [attachment] : [];
    });
  }

  discardPreparedAttachment(id: number) {
    this.preparedIds.delete(id);
  }

  carryPendingAttachment(previous: ImageAttachment) {
    const existing = this.attachments.get(previous.id);
    if (
      existing &&
      !this.submittedIds.has(existing.id) &&
      existing.path === previous.path
    ) {
      return { attachment: existing, shouldPersist: false };
    }

    if (!this.usedIds.has(previous.id)) {
      const attachment = { ...previous };
      this.attachments.set(attachment.id, attachment);
      this.usedIds.add(attachment.id);
      this.nextId = Math.max(this.nextId, attachment.id + 1);
      return { attachment, shouldPersist: true };
    }

    const attachment = this.registerClipboardPath(previous.path);
    if (!attachment) return undefined;
    return { attachment, shouldPersist: true };
  }

  registrationEntry(attachment: ImageAttachment) {
    return {
      kind: "registered",
      id: attachment.id,
      path: attachment.path,
      mimeType: attachment.mimeType,
    } satisfies RegisteredAttachmentEntry;
  }

  reconcilePreparedImages(text: string, images: ImageContent[]) {
    const replacements = new Map<number, number>();
    const registrations: ImageAttachment[] = [];

    for (const image of images) {
      const previous = this.preparedImageAttachments.get(image);
      if (!previous) continue;
      const current = this.attachments.get(previous.id);
      if (
        current &&
        !this.submittedIds.has(current.id) &&
        current.path === previous.path
      ) {
        this.preparedImageAttachments.set(image, current);
        continue;
      }

      const carried = this.carryPendingAttachment(previous);
      if (!carried) continue;
      this.preparedImageAttachments.set(image, carried.attachment);
      if (carried.shouldPersist) registrations.push(carried.attachment);
      if (carried.attachment.id !== previous.id) {
        this.preparedIds.delete(previous.id);
        this.preparedIds.add(carried.attachment.id);
        replacements.set(previous.id, carried.attachment.id);
      }
    }

    return {
      text: replaceImageLabels(text, replacements),
      registrations,
    };
  }

  submittedEntry(ids: number[]) {
    return {
      kind: "submitted",
      ids: [...new Set(ids)],
    } satisfies SubmittedAttachmentsEntry;
  }

  private referencedAttachments(text: string, pendingOnly: boolean) {
    const seen = new Set<number>();
    const attachments: ImageAttachment[] = [];

    for (const id of markerIds(text)) {
      if (seen.has(id) || (pendingOnly && this.submittedIds.has(id))) continue;
      const attachment = this.attachments.get(id);
      if (!attachment) continue;
      seen.add(id);
      attachments.push(attachment);
    }

    return attachments;
  }

  hasPendingImages(text: string) {
    return this.referencedAttachments(text, true).length > 0;
  }

  async preparePendingImages(text: string) {
    const preparationGeneration = this.generation;
    const attachments = this.referencedAttachments(text, true);
    this.activePreparations += 1;
    let prepared: PromiseSettledResult<PreparedImage>[];
    try {
      prepared = await Promise.allSettled(
        attachments.map(async (attachment) => ({
          attachment,
          image: await this.loader(attachment),
        })),
      );
    } finally {
      this.activePreparations -= 1;
    }

    const images: PreparedImage[] = [];
    const failures: ImagePreparationFailure[] = [];
    for (const [index, result] of prepared.entries()) {
      const attachment =
        result.status === "fulfilled"
          ? result.value.attachment
          : attachments[index];
      if (!attachment) continue;

      if (preparationGeneration !== this.generation) {
        failures.push({
          attachment,
          reason: "the session changed while the image was loading",
        });
      } else if (result.status === "fulfilled") {
        images.push(result.value);
        this.preparedImageAttachments.set(result.value.image, attachment);
        this.preparedIds.add(attachment.id);
        this.unavailableIds.delete(attachment.id);
      } else {
        this.unavailableIds.add(attachment.id);
        failures.push({ attachment, reason: errorMessage(result.reason) });
      }
    }

    return {
      images: images.map((item) => item.image),
      attachmentIds: images.map((item) => item.attachment.id),
      failures,
    } satisfies PreparedImages;
  }

  markPreparedAsSubmitted(text: string, images: ImageContent[] = []) {
    const fromImages = new Set(
      images.flatMap((image) => {
        const attachment = this.preparedImageAttachments.get(image);
        return attachment ? [attachment.id] : [];
      }),
    );
    const submitted = [
      ...this.referencedAttachments(text, false).map(
        (attachment) => attachment.id,
      ),
      ...fromImages,
    ].filter(
      (id, index, ids) =>
        (this.preparedIds.has(id) || fromImages.has(id)) &&
        ids.indexOf(id) === index,
    );
    for (const id of submitted) {
      this.preparedIds.delete(id);
      this.submittedIds.add(id);
    }
    return submitted;
  }

  annotateFailures(text: string, failures: ImagePreparationFailure[]) {
    let annotated = text;
    for (const { attachment } of failures) {
      annotated = annotated.replaceAll(
        attachment.label,
        `[Image #${attachment.id} unavailable]`,
      );
    }
    return annotated;
  }

  localPathHints(text: string) {
    return this.referencedAttachments(text, false)
      .filter((attachment) => !this.unavailableIds.has(attachment.id))
      .map((attachment) => `${attachment.label}: ${attachment.path}`);
  }
}
