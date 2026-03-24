import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { parseDurableNote, type DurableSourceAnchor } from "../../memory/durable-note.js";
import { extractSessionText } from "../../memory/session-files.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const MemoryExpandSchema = Type.Object({
  path: Type.String(),
  includeSidecar: Type.Optional(Type.Boolean()),
  expandAnchors: Type.Optional(Type.Boolean()),
  maxAnchors: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  anchorContextTurns: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  sessionQuery: Type.Optional(Type.String()),
  maxSessionHits: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

async function getMemoryManagerContext(params: { cfg: OpenClawConfig; agentId: string }): Promise<
  | {
      manager: NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return manager ? { manager } : { error };
}

function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema | typeof MemoryExpandSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId });
          const results =
            status.backend === "qmd"
              ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
              : decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            fallback: status.fallback,
            citations: citationsMode,
            mode: searchMode,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        try {
          const result = await memory.manager.readFile({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
          });
          return jsonResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ path: relPath, text: "", disabled: true, error: message });
        }
      },
  });
}

type VisibleSessionTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnNumber: number;
  jsonlLine: number;
};

function readBooleanOption(
  params: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  const snakeKey = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
  const raw = params[key] ?? params[snakeKey];
  return typeof raw === "boolean" ? raw : defaultValue;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeVisibleText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\[\[reply_to_current\]\]\s*/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

function shouldIgnoreVisibleUserText(text: string): boolean {
  return (
    !text ||
    text.startsWith("/") ||
    text.startsWith("A new session was started via /new or /reset.") ||
    text.startsWith("A session was compacted.")
  );
}

function shouldIgnoreVisibleAssistantEntry(entry: Record<string, unknown>, text: string): boolean {
  const message = entry.message as { provider?: unknown; model?: unknown } | undefined;
  const provider = entry.provider ?? message?.provider ?? null;
  const model = entry.model ?? message?.model ?? null;
  return (
    !text ||
    provider === "openclaw" ||
    model === "gateway-injected" ||
    text.startsWith("OpenClaw ") ||
    text.includes("Queue: collect")
  );
}

async function readVisibleSessionTurns(sessionFile: string): Promise<VisibleSessionTurn[]> {
  const raw = await fs.readFile(sessionFile, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const turns: VisibleSessionTurn[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[lineIndex] ?? "");
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") {
      continue;
    }
    const message = (entry as { message?: unknown }).message as
      | { role?: unknown; content?: unknown }
      | undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const visibleText = normalizeVisibleText(extractSessionText(message.content) ?? "");
    if (message.role === "user") {
      if (shouldIgnoreVisibleUserText(visibleText)) {
        continue;
      }
    } else if (shouldIgnoreVisibleAssistantEntry(entry as Record<string, unknown>, visibleText)) {
      continue;
    }
    if (!visibleText) {
      continue;
    }
    turns.push({
      id:
        typeof (entry as { id?: unknown }).id === "string" && (entry as { id?: string }).id
          ? ((entry as { id: string }).id)
          : `${message.role}-${turns.length + 1}`,
      role: message.role,
      text: visibleText,
      turnNumber: turns.length + 1,
      jsonlLine: lineIndex + 1,
    });
  }
  return turns;
}

function formatVisibleTurnSlice(turns: VisibleSessionTurn[]): string {
  return turns
    .map((turn) => {
      const label = `T${String(turn.turnNumber).padStart(4, "0")}`;
      const role = turn.role === "user" ? "User" : "Assistant";
      return `${label} L${turn.jsonlLine} ${role}: ${turn.text}`;
    })
    .join("\n");
}

function anchorIdentity(anchor: DurableSourceAnchor): string {
  return JSON.stringify({
    sourcePath: anchor.sourcePath ?? null,
    turnStart: anchor.turnStart ?? null,
    turnEnd: anchor.turnEnd ?? null,
    jsonlLineStart: anchor.jsonlLineStart ?? null,
    jsonlLineEnd: anchor.jsonlLineEnd ?? null,
    messageIds: anchor.messageIds,
  });
}

function dedupeAnchors(anchors: DurableSourceAnchor[]): DurableSourceAnchor[] {
  const seen = new Set<string>();
  const result: DurableSourceAnchor[] = [];
  for (const anchor of anchors) {
    const key = anchorIdentity(anchor);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(anchor);
  }
  return result;
}

function normalizeMemoryPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function resolveWorkspaceMemoryPath(workspaceDir: string, relPath: string): string {
  const normalized = normalizeMemoryPath(relPath);
  if (!normalized) {
    throw new ToolInputError("path required");
  }
  if (!(normalized === "MEMORY.md" || normalized === "memory.md" || normalized.startsWith("memory/"))) {
    throw new ToolInputError("path must point to MEMORY.md or memory/*.md");
  }
  if (!normalized.endsWith(".md")) {
    throw new ToolInputError("path must point to a markdown file");
  }
  const absPath = path.resolve(workspaceDir, normalized);
  const normalizedWorkspace = workspaceDir.endsWith(path.sep) ? workspaceDir : `${workspaceDir}${path.sep}`;
  if (absPath !== workspaceDir && !absPath.startsWith(normalizedWorkspace)) {
    throw new ToolInputError("path escapes workspace");
  }
  return absPath;
}

type ResolvedSessionFile = {
  absPath: string;
  sessionPath: string;
};

async function listSessionFileNames(sessionsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function resolveSessionNameFromCandidate(names: string[], candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  const baseName = path.basename(trimmed);
  if (names.includes(baseName)) {
    return baseName;
  }
  const sessionIdMatch = /^([a-z0-9-]+)\.jsonl(?:\.reset\..+)?$/i.exec(baseName);
  const sessionId = sessionIdMatch?.[1] ?? trimmed;
  const exact = names.find((name) => name === `${sessionId}.jsonl`);
  if (exact) {
    return exact;
  }
  const reset = names
    .filter((name) => name.startsWith(`${sessionId}.jsonl.reset.`))
    .sort()
    .reverse()[0];
  if (reset) {
    return reset;
  }
  const topicVariant = names
    .filter((name) => name.startsWith(`${sessionId}-topic-`) && name.endsWith(".jsonl") && !name.includes(".reset."))
    .sort()
    .reverse()[0];
  return topicVariant ?? null;
}

async function resolveSessionFile(params: {
  sessionsDir: string;
  sessionNames: string[];
  anchor: DurableSourceAnchor | null;
  noteSourcePath: string | null;
  sourceSessions: string[];
}): Promise<ResolvedSessionFile | null> {
  const candidates = [
    params.anchor?.sourcePath ?? null,
    params.noteSourcePath,
    ...params.sourceSessions.map((sessionId) => `${sessionId}.jsonl`),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const resolvedName = resolveSessionNameFromCandidate(params.sessionNames, candidate);
    if (!resolvedName) {
      continue;
    }
    return {
      absPath: path.join(params.sessionsDir, resolvedName),
      sessionPath: `sessions/${resolvedName}`.replace(/\\/g, "/"),
    };
  }
  return null;
}

function resolveAnchorWindow(
  turns: VisibleSessionTurn[],
  anchor: DurableSourceAnchor,
  contextTurns: number,
): VisibleSessionTurn[] {
  if (turns.length === 0) {
    return [];
  }
  let startIndex = -1;
  let endIndex = -1;
  if (anchor.turnStart) {
    const turnStart = anchor.turnStart;
    const turnEnd = anchor.turnEnd ?? turnStart;
    startIndex = turns.findIndex((turn) => turn.turnNumber >= turnStart);
    endIndex = turns.findLastIndex((turn) => turn.turnNumber <= turnEnd);
  }
  if ((startIndex === -1 || endIndex === -1) && anchor.jsonlLineStart) {
    const lineStart = anchor.jsonlLineStart;
    const lineEnd = anchor.jsonlLineEnd ?? lineStart;
    startIndex = turns.findIndex((turn) => turn.jsonlLine >= lineStart);
    endIndex = turns.findLastIndex((turn) => turn.jsonlLine <= lineEnd);
  }
  if (startIndex === -1 || endIndex === -1) {
    return [];
  }
  const safeStart = Math.max(0, startIndex - contextTurns);
  const safeEnd = Math.min(turns.length - 1, endIndex + contextTurns);
  return turns.slice(safeStart, safeEnd + 1);
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9._-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length > 1),
    ),
  );
}

function scoreQueryAgainstText(text: string, tokens: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) {
      continue;
    }
    score += 1;
    let index = haystack.indexOf(token);
    while (index !== -1) {
      score += 0.1;
      index = haystack.indexOf(token, index + token.length);
    }
  }
  return Number(score.toFixed(2));
}

function buildQueryWindows(
  turns: VisibleSessionTurn[],
  sessionPath: string,
  tokens: string[],
  contextTurns: number,
  maxHits: number,
) {
  const windows = [];
  const seen = new Set<string>();
  for (let index = 0; index < turns.length; index += 1) {
    const start = Math.max(0, index - contextTurns);
    const end = Math.min(turns.length - 1, index + contextTurns);
    const slice = turns.slice(start, end + 1);
    const snippet = formatVisibleTurnSlice(slice);
    const score = scoreQueryAgainstText(snippet, tokens);
    if (score <= 0) {
      continue;
    }
    const first = slice[0];
    const last = slice[slice.length - 1];
    const key = `${first?.turnNumber ?? 0}-${last?.turnNumber ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    windows.push({
      sessionPath,
      turnStart: first?.turnNumber ?? null,
      turnEnd: last?.turnNumber ?? null,
      jsonlLineStart: first?.jsonlLine ?? null,
      jsonlLineEnd: last?.jsonlLine ?? null,
      snippet,
      score,
    });
  }
  return windows
    .sort((left, right) => right.score - left.score || (left.turnStart ?? 0) - (right.turnStart ?? 0))
    .slice(0, maxHits);
}

export function createMemoryExpandTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Expand",
    name: "memory_expand",
    description:
      "Expand an indexed memory note into its sidecar details, parsed source anchors, and on-demand source-session slices. Use after memory_search + memory_get when the indexed note is not detailed enough.",
    parameters: MemoryExpandSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const includeSidecar = readBooleanOption(params, "includeSidecar", true);
        const expandAnchors = readBooleanOption(params, "expandAnchors", true);
        const maxAnchors = clampInteger(readNumberParam(params, "maxAnchors", { integer: true }), 1, 8, 2);
        const anchorContextTurns = clampInteger(
          readNumberParam(params, "anchorContextTurns", { integer: true }),
          0,
          2,
          1,
        );
        const sessionQuery = readStringParam(params, "sessionQuery");
        const maxSessionHits = clampInteger(
          readNumberParam(params, "maxSessionHits", { integer: true }),
          1,
          8,
          3,
        );
        const warnings: string[] = [];
        try {
          const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const notePath = resolveWorkspaceMemoryPath(workspaceDir, relPath);
          const rawNote = await fs.readFile(notePath, "utf8");
          const parsedNote = parseDurableNote(rawNote);
          let sidecar:
            | {
                path: string;
                text: string;
                loaded: boolean;
              }
            | null = null;
          let combinedAnchors = parsedNote.sourceAnchors;

          if (includeSidecar && parsedNote.sidecarPath) {
            try {
              const sidecarPath = resolveWorkspaceMemoryPath(workspaceDir, parsedNote.sidecarPath);
              const rawSidecar = await fs.readFile(sidecarPath, "utf8");
              const parsedSidecar = parseDurableNote(rawSidecar);
              sidecar = { path: parsedNote.sidecarPath, text: rawSidecar, loaded: true };
              combinedAnchors = dedupeAnchors([...combinedAnchors, ...parsedSidecar.sourceAnchors]);
            } catch (error) {
              warnings.push(`sidecar unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
          const sessionNames = expandAnchors || sessionQuery ? await listSessionFileNames(sessionsDir) : [];
          const selectedAnchors = expandAnchors ? dedupeAnchors(combinedAnchors).slice(0, maxAnchors) : [];
          const anchorResults: Array<{
            sourcePath: string | null;
            sessionPath: string | null;
            turnStart: number | null;
            turnEnd: number | null;
            jsonlLineStart: number | null;
            jsonlLineEnd: number | null;
            excerpt: string;
            sliceText: string;
          }> = [];
          const turnCache = new Map<string, VisibleSessionTurn[]>();
          const searchedSessions = new Set<string>();

          for (const anchor of selectedAnchors) {
            const resolvedSession = await resolveSessionFile({
              sessionsDir,
              sessionNames,
              anchor,
              noteSourcePath: parsedNote.sourcePath,
              sourceSessions: parsedNote.sourceSessions,
            });
            if (!resolvedSession) {
              warnings.push(`source session unavailable for anchor: ${anchor.sourcePath ?? "unknown"}`);
              anchorResults.push({
                sourcePath: anchor.sourcePath,
                sessionPath: null,
                turnStart: anchor.turnStart,
                turnEnd: anchor.turnEnd,
                jsonlLineStart: anchor.jsonlLineStart,
                jsonlLineEnd: anchor.jsonlLineEnd,
                excerpt: anchor.excerpt,
                sliceText: "",
              });
              continue;
            }
            searchedSessions.add(resolvedSession.sessionPath);
            let turns = turnCache.get(resolvedSession.absPath);
            if (!turns) {
              turns = await readVisibleSessionTurns(resolvedSession.absPath);
              turnCache.set(resolvedSession.absPath, turns);
            }
            const slice = resolveAnchorWindow(turns, anchor, anchorContextTurns);
            if (slice.length === 0) {
              warnings.push(`anchor window not found in ${resolvedSession.sessionPath}`);
            }
            const first = slice[0];
            const last = slice[slice.length - 1];
            anchorResults.push({
              sourcePath: anchor.sourcePath,
              sessionPath: resolvedSession.sessionPath,
              turnStart: first?.turnNumber ?? anchor.turnStart,
              turnEnd: last?.turnNumber ?? anchor.turnEnd,
              jsonlLineStart: first?.jsonlLine ?? anchor.jsonlLineStart,
              jsonlLineEnd: last?.jsonlLine ?? anchor.jsonlLineEnd,
              excerpt: anchor.excerpt,
              sliceText: formatVisibleTurnSlice(slice),
            });
          }

          let sessionSearch:
            | {
                query: string;
                searched: string[];
                results: Array<{
                  sessionPath: string;
                  turnStart: number | null;
                  turnEnd: number | null;
                  jsonlLineStart: number | null;
                  jsonlLineEnd: number | null;
                  snippet: string;
                  score: number;
                }>;
              }
            | null = null;
          if (sessionQuery) {
            const tokens = tokenizeQuery(sessionQuery);
            const resolvedSessions: ResolvedSessionFile[] = [];
            const seenSessionPaths = new Set<string>();
            const anchorCandidates = combinedAnchors.length > 0 ? combinedAnchors : [null];
            for (const anchor of anchorCandidates) {
              const resolvedSession = await resolveSessionFile({
                sessionsDir,
                sessionNames,
                anchor,
                noteSourcePath: parsedNote.sourcePath,
                sourceSessions: parsedNote.sourceSessions,
              });
              if (!resolvedSession || seenSessionPaths.has(resolvedSession.sessionPath)) {
                continue;
              }
              seenSessionPaths.add(resolvedSession.sessionPath);
              resolvedSessions.push(resolvedSession);
            }
            if (resolvedSessions.length === 0) {
              warnings.push("no source sessions available for sessionQuery");
            }
            const results = [];
            for (const resolvedSession of resolvedSessions) {
              searchedSessions.add(resolvedSession.sessionPath);
              let turns = turnCache.get(resolvedSession.absPath);
              if (!turns) {
                turns = await readVisibleSessionTurns(resolvedSession.absPath);
                turnCache.set(resolvedSession.absPath, turns);
              }
              results.push(...buildQueryWindows(turns, resolvedSession.sessionPath, tokens, anchorContextTurns, maxSessionHits));
            }
            sessionSearch = {
              query: sessionQuery,
              searched: Array.from(searchedSessions),
              results: results
                .sort((left, right) => right.score - left.score || (left.turnStart ?? 0) - (right.turnStart ?? 0))
                .slice(0, maxSessionHits),
            };
          }

          return jsonResult({
            note: {
              path: normalizeMemoryPath(relPath),
              title: parsedNote.title,
              summary: parsedNote.summary,
              whyItMatters: parsedNote.whyItMatters,
              sidecarPath: parsedNote.sidecarPath,
            },
            sidecar,
            anchors: anchorResults,
            sessionSearch,
            warnings,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResult({
            note: null,
            sidecar: null,
            anchors: [],
            sessionSearch: null,
            warnings: [message],
            disabled: true,
            error: message,
          });
        }
      },
  });
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
