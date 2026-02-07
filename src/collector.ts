// Data collector - reads Codex CLI storage and returns raw data

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";

const CODEX_DATA_PATH = join(os.homedir(), ".codex");
const CODEX_HISTORY_PATH = join(CODEX_DATA_PATH, "history.jsonl");
const CODEX_SESSIONS_PATH = join(CODEX_DATA_PATH, "sessions");

export interface CodexUsageEvent {
  timestamp: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexUsageData {
  events: CodexUsageEvent[];
  dailyActivity: Map<string, number>;
  totalMessages: number;
  totalSessions: number;
  projects: Set<string>;
  earliestSessionDate: Date | null;
}

export async function checkCodexDataExists(): Promise<boolean> {
  try {
    const info = await stat(CODEX_SESSIONS_PATH);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function listCodexSessionFiles(year: number): Promise<string[]> {
  const yearPath = join(CODEX_SESSIONS_PATH, String(year));
  return listCodexSessionFilesInDirectory(yearPath);
}

async function listAllCodexSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  let yearDirs: Array<string> = [];
  try {
    const entries = await readdir(CODEX_SESSIONS_PATH, { withFileTypes: true });
    yearDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return files;
  }

  for (const yearDir of yearDirs) {
    const yearPath = join(CODEX_SESSIONS_PATH, yearDir);
    files.push(...(await listCodexSessionFilesInDirectory(yearPath)));
  }

  return files;
}

async function listCodexSessionFilesInDirectory(yearPath: string): Promise<string[]> {
  const files: string[] = [];
  let monthDirs: Array<string> = [];
  try {
    const entries = await readdir(yearPath, { withFileTypes: true });
    monthDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return files;
  }

  for (const month of monthDirs) {
    const monthPath = join(yearPath, month);
    let dayDirs: Array<string> = [];
    try {
      const entries = await readdir(monthPath, { withFileTypes: true });
      dayDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }

    for (const day of dayDirs) {
      const dayPath = join(monthPath, day);
      try {
        const entries = await readdir(dayPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.push(join(dayPath, entry.name));
          }
        }
      } catch {
        // Ignore unreadable day directories
      }
    }
  }

  return files;
}

export async function getCodexFirstPromptTimestamp(): Promise<number | null> {
  try {
    const raw = await readFile(CODEX_HISTORY_PATH, "utf8");
    let minTs: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { ts?: number };
        if (!entry.ts) continue;
        if (minTs === null || entry.ts < minTs) {
          minTs = entry.ts;
        }
      } catch {
        // Skip malformed lines
      }
    }
    return minTs;
  } catch {
    return null;
  }
}

export async function collectCodexUsageData(year: number): Promise<CodexUsageData> {
  const files = await listAllCodexSessionFiles();
  const sessions: SessionUsage[] = [];

  for (const filePath of files) {
    let snapshotSize = 0;
    try {
      const fileInfo = await stat(filePath);
      snapshotSize = fileInfo.size;
    } catch {
      continue;
    }

    if (snapshotSize <= 0) {
      continue;
    }

    let previousTotals: RawUsage | null = null;
    let currentModel: string | undefined;
    let currentModelIsFallback = false;
    let legacyFallbackUsed = false;
    let sessionDate: Date | null = null;
    let sessionCwd: string | undefined;
    let sessionId: string | undefined;
    let forkedFromId: string | undefined;
    const userMessages: SessionUserMessage[] = [];
    const sessionEvents: CodexUsageEvent[] = [];

    const rl = createInterface({
      input: createReadStream(filePath, { start: 0, end: snapshotSize - 1 }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const entryType = entry?.type;

      if (entryType === "session_meta") {
        const metaPayload = entry?.payload;
        const sessionTimestamp = entry?.payload?.timestamp ?? entry?.timestamp;
        if (sessionTimestamp) {
          const parsedDate = new Date(sessionTimestamp);
          if (!sessionDate || parsedDate < sessionDate) {
            sessionDate = parsedDate;
          }
        }
        const cwd = entry?.payload?.cwd;
        if (cwd) {
          sessionCwd = cwd;
        }
        if (!sessionId) {
          const parsedSessionId = asNonEmptyString(metaPayload?.id);
          if (parsedSessionId) {
            sessionId = parsedSessionId;
          }
        }
        if (!forkedFromId) {
          const parsedForkedFromId = asNonEmptyString(metaPayload?.forked_from_id);
          if (parsedForkedFromId) {
            forkedFromId = parsedForkedFromId;
          }
        }
        continue;
      }

      if (entryType === "turn_context") {
        const model = extractModel(entry?.payload);
        if (model) {
          currentModel = model;
          currentModelIsFallback = false;
        }
        continue;
      }

      if (entryType === "event_msg") {
        const payload = entry?.payload;
        if (payload?.type === "user_message") {
          const timestamp = entry?.timestamp;
          if (timestamp && isTimestampInYear(timestamp, year)) {
            userMessages.push({
              timestamp,
              signature: createUserMessageSignature(payload),
            });
          }
          continue;
        }

        if (payload?.type !== "token_count") {
          continue;
        }

        const timestamp = entry?.timestamp;
        if (!timestamp) continue;
        const inTargetYear = isTimestampInYear(timestamp, year);

        const info = payload?.info;
        const lastUsage = normalizeRawUsage(info?.last_token_usage);
        const totalUsage = normalizeRawUsage(info?.total_token_usage);

        let raw = lastUsage;
        if (!raw && totalUsage) {
          raw = subtractRawUsage(totalUsage, previousTotals);
        }

        if (totalUsage) {
          previousTotals = totalUsage;
        }

        if (!raw) continue;

        const delta = convertToDelta(raw);
        if (
          delta.inputTokens === 0 &&
          delta.cachedInputTokens === 0 &&
          delta.outputTokens === 0 &&
          delta.reasoningOutputTokens === 0
        ) {
          continue;
        }

        const extractedModel = extractModel({ ...payload, info });
        let isFallback = false;
        if (extractedModel) {
          currentModel = extractedModel;
          currentModelIsFallback = false;
        }

        let model = extractedModel ?? currentModel;
        if (!model) {
          model = LEGACY_FALLBACK_MODEL;
          isFallback = true;
          legacyFallbackUsed = true;
          currentModel = model;
          currentModelIsFallback = true;
        } else if (!extractedModel && currentModelIsFallback) {
          isFallback = true;
        }

        if (!inTargetYear) {
          continue;
        }

        sessionEvents.push({
          timestamp,
          model,
          inputTokens: delta.inputTokens,
          cachedInputTokens: delta.cachedInputTokens,
          outputTokens: delta.outputTokens,
          reasoningOutputTokens: delta.reasoningOutputTokens,
          totalTokens: delta.totalTokens,
        });

        if (isFallback) {
          // No-op for now; kept for parity with ccusage
        }
      }
    }

    if (legacyFallbackUsed) {
      // ignore - best-effort
    }

    sessions.push({
      filePath,
      cwd: sessionCwd,
      sessionId,
      forkedFromId,
      sessionDate,
      hasYearActivity: userMessages.length > 0 || sessionEvents.length > 0,
      userMessages,
      messageSignatures: userMessages.map((message) => message.signature),
      events: sessionEvents,
      tokenSignatures: sessionEvents.map(createTokenEventSignature),
    });
  }

  const events: CodexUsageEvent[] = [];
  const dailyActivity = new Map<string, number>();
  const projects = new Set<string>();
  let totalMessages = 0;
  let totalSessions = 0;
  let earliestSessionDate: Date | null = null;
  const priorSessionsByCwd = new Map<string, CwdDedupIndex>();
  const sessionsById = new Map<string, SessionDedupSignatures>();

  sessions.sort(compareSessionsByDate);

  for (const session of sessions) {
    if (session.sessionDate && (!earliestSessionDate || session.sessionDate < earliestSessionDate)) {
      earliestSessionDate = session.sessionDate;
    }

    if (session.hasYearActivity) {
      totalSessions += 1;
      if (session.cwd) {
        projects.add(session.cwd);
      }
    }

    let messageStartIndex = 0;
    let tokenStartIndex = 0;
    const parentSession = session.forkedFromId ? sessionsById.get(session.forkedFromId) : undefined;

    if (parentSession) {
      const messageOverlap = commonPrefixLength(session.messageSignatures, parentSession.messageSignatures);
      messageStartIndex = messageOverlap;

      const tokenOverlap = commonPrefixLength(session.tokenSignatures, parentSession.tokenSignatures);
      tokenStartIndex = tokenOverlap;
    } else if (session.cwd) {
      const previous = priorSessionsByCwd.get(session.cwd) ?? { messageSequences: [], tokenSequences: [] };

      if (session.messageSignatures.length > 0) {
        const messageOverlap = findLargestPrefixOverlap(session.messageSignatures, previous.messageSequences);
        if (shouldApplyForkDedup(messageOverlap, session.messageSignatures.length)) {
          messageStartIndex = messageOverlap;
        }
      }

      if (session.tokenSignatures.length > 0) {
        const tokenOverlap = findLargestPrefixOverlap(session.tokenSignatures, previous.tokenSequences);
        if (shouldApplyForkDedup(tokenOverlap, session.tokenSignatures.length)) {
          tokenStartIndex = tokenOverlap;
        }
      }

      if (session.messageSignatures.length > 0 || session.tokenSignatures.length > 0) {
        if (session.messageSignatures.length > 0) {
          previous.messageSequences.push(session.messageSignatures);
        }
        if (session.tokenSignatures.length > 0) {
          previous.tokenSequences.push(session.tokenSignatures);
        }
        priorSessionsByCwd.set(session.cwd, previous);
      }
    }

    for (const message of session.userMessages.slice(messageStartIndex)) {
      totalMessages += 1;
      const dateKey = formatDateKey(new Date(message.timestamp));
      dailyActivity.set(dateKey, (dailyActivity.get(dateKey) || 0) + 1);
    }

    events.push(...session.events.slice(tokenStartIndex));

    if (session.sessionId) {
      sessionsById.set(session.sessionId, {
        messageSignatures: session.messageSignatures,
        tokenSignatures: session.tokenSignatures,
      });
    }
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    events,
    dailyActivity,
    totalMessages,
    totalSessions,
    projects,
    earliestSessionDate,
  };
}

type RawUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

type SessionUserMessage = {
  timestamp: string;
  signature: string;
};

type SessionDedupSignatures = {
  messageSignatures: string[];
  tokenSignatures: string[];
};

type CwdDedupIndex = {
  messageSequences: string[][];
  tokenSequences: string[][];
};

type SessionUsage = SessionDedupSignatures & {
  filePath: string;
  cwd?: string;
  sessionId?: string;
  forkedFromId?: string;
  sessionDate: Date | null;
  hasYearActivity: boolean;
  userMessages: SessionUserMessage[];
  events: CodexUsageEvent[];
};

const LEGACY_FALLBACK_MODEL = "gpt-5";
const FORK_PREFIX_MIN_MATCH = 3;

function ensureNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeRawUsage(value: unknown): RawUsage | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const input = ensureNumber(record.input_tokens);
  const cached = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
  const output = ensureNumber(record.output_tokens);
  const reasoning = ensureNumber(record.reasoning_output_tokens);
  const total = ensureNumber(record.total_tokens);

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total > 0 ? total : input + output,
  };
}

function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
  return {
    input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens ?? 0), 0),
    output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
    reasoning_output_tokens: Math.max(current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0), 0),
    total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
  };
}

function convertToDelta(raw: RawUsage): Omit<CodexUsageEvent, "timestamp" | "model"> {
  const total = raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens;
  const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
  return {
    inputTokens: raw.input_tokens,
    cachedInputTokens: cached,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens,
    totalTokens: total,
  };
}

function extractModel(value: unknown): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;

  const info = payload.info;
  if (info && typeof info === "object") {
    const infoRecord = info as Record<string, unknown>;
    const direct = [infoRecord.model, infoRecord.model_name];
    for (const candidate of direct) {
      const model = asNonEmptyString(candidate);
      if (model) return model;
    }
    if (infoRecord.metadata && typeof infoRecord.metadata === "object") {
      const model = asNonEmptyString((infoRecord.metadata as Record<string, unknown>).model);
      if (model) return model;
    }
  }

  const fallbackModel = asNonEmptyString(payload.model);
  if (fallbackModel) return fallbackModel;

  if (payload.metadata && typeof payload.metadata === "object") {
    const model = asNonEmptyString((payload.metadata as Record<string, unknown>).model);
    if (model) return model;
  }

  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function createUserMessageSignature(payload: Record<string, unknown>): string {
  const message = asNonEmptyString(payload.message) ?? "";
  const textElements = Array.isArray(payload.text_elements) ? payload.text_elements : [];
  const imageCount = Array.isArray(payload.images) ? payload.images.length : 0;
  const localImageCount = Array.isArray(payload.local_images) ? payload.local_images.length : 0;
  return JSON.stringify({
    message,
    textElements,
    imageCount,
    localImageCount,
  });
}

function createTokenEventSignature(event: CodexUsageEvent): string {
  return [
    event.model,
    event.inputTokens,
    event.cachedInputTokens,
    event.outputTokens,
    event.reasoningOutputTokens,
    event.totalTokens,
  ].join("|");
}

function compareSessionsByDate(a: SessionUsage, b: SessionUsage): number {
  const aTime = a.sessionDate?.getTime();
  const bTime = b.sessionDate?.getTime();

  if (aTime != null && bTime != null && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aTime != null && bTime == null) return -1;
  if (aTime == null && bTime != null) return 1;
  return a.filePath.localeCompare(b.filePath);
}

function shouldApplyForkDedup(overlap: number, sequenceLength: number): boolean {
  if (overlap < FORK_PREFIX_MIN_MATCH) return false;
  if (sequenceLength <= 4) {
    return overlap === sequenceLength;
  }
  return true;
}

function findLargestPrefixOverlap(sequence: string[], candidateSequences: string[][]): number {
  if (sequence.length === 0 || candidateSequences.length === 0) return 0;

  let best = 0;
  for (const candidate of candidateSequences) {
    if (candidate.length === 0) continue;
    const overlap = commonPrefixLength(sequence, candidate);
    if (overlap > best) {
      best = overlap;
      if (best === sequence.length) return best;
    }
  }

  return best;
}

function commonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function isTimestampInYear(timestamp: string, year: number): boolean {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getFullYear() === year;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
