import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const MAX_PROMPT_HISTORY = 100;

const LOCK_RETRY_MS = 10;
const LOCK_RETRY_LIMIT = 100;
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface PromptHistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface PromptHistoryMetadata {
  project: string;
  sessionId: string;
}

interface ParsedHistoryLine {
  display: string;
  raw: string;
}

function errorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function parseLine(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("display" in value) ||
      typeof value.display !== "string"
    ) {
      return undefined;
    }

    const display = value.display.trim();
    return display ? ({ display, raw } satisfies ParsedHistoryLine) : undefined;
  } catch {
    return undefined;
  }
}

function readValidLines(path: string) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map(parseLine)
      .filter((entry): entry is ParsedHistoryLine => entry !== undefined);
  } catch {
    return [];
  }
}

function removeStaleLock(lockPath: string) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= STALE_LOCK_MS) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireHistoryLock(lockPath: string) {
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return undefined;
      if (removeStaleLock(lockPath)) continue;
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
    }
  }
  return undefined;
}

function withHistoryLock(path: string, action: () => boolean) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return false;
  }

  const lockPath = `${path}.lock`;
  const lock = acquireHistoryLock(lockPath);
  if (lock === undefined) return false;

  try {
    return action();
  } catch {
    return false;
  } finally {
    try {
      closeSync(lock);
    } catch {
      // Persistence failures must never interrupt editor submission.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock cleanup may already have removed it.
    }
  }
}

function compactHistory(path: string) {
  const entries = readValidLines(path);
  if (entries.length <= MAX_PROMPT_HISTORY) return;

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const recent = entries.slice(-MAX_PROMPT_HISTORY);
    writeFileSync(
      tempPath,
      `${recent.map((entry) => entry.raw).join("\n")}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    renameSync(tempPath, path);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not have been created.
    }
  }
}

export function readPromptHistory(path: string, limit = MAX_PROMPT_HISTORY) {
  return readValidLines(path)
    .slice(-limit)
    .map((entry) => entry.display)
    .reverse();
}

export class PromptHistoryReplayGuard {
  private expected: string[] = [];

  expect(prompts: string[]) {
    this.expected = prompts.map((prompt) => prompt.trim()).filter(Boolean);
  }

  consume(text: string) {
    const prompt = text.trim();
    if (this.expected[0] !== prompt) {
      this.expected = [];
      return false;
    }

    this.expected.shift();
    return true;
  }
}

export class PromptHistory {
  private readonly path: string;
  private readonly metadata: PromptHistoryMetadata;
  private readonly prompts: string[];

  constructor(path: string, metadata: PromptHistoryMetadata) {
    this.path = path;
    this.metadata = metadata;
    this.prompts = readPromptHistory(path);
  }

  get values() {
    return [...this.prompts];
  }

  record(text: string) {
    const display = text.trim();
    if (!display) return false;

    const entry: PromptHistoryEntry = {
      display,
      timestamp: Date.now(),
      project: this.metadata.project,
      sessionId: this.metadata.sessionId,
    };

    return withHistoryLock(this.path, () => {
      const current = readPromptHistory(this.path);
      if (current[0] === display) {
        this.prompts.splice(0, this.prompts.length, ...current);
        return false;
      }

      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      compactHistory(this.path);

      this.prompts.splice(
        0,
        this.prompts.length,
        display,
        ...current.slice(0, MAX_PROMPT_HISTORY - 1),
      );
      return true;
    });
  }
}
