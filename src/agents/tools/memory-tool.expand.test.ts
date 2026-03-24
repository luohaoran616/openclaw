import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMemoryExpandToolOrThrow } from "./memory-tool.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";

const tempDirs: string[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
  } as OpenClawConfig;
}

function makeSessionTranscript(lines: Array<Record<string, unknown>>): string {
  return `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("memory_expand", () => {
  it("loads sidecar content and expands anchor slices from the source session", async () => {
    const workspaceDir = await makeTempDir("openclaw-memory-expand-workspace-");
    const stateDir = await makeTempDir("openclaw-memory-expand-state-");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const indexedDir = path.join(workspaceDir, "memory", "indexed", "decisions");
    const sidecarDir = path.join(workspaceDir, "memory", "archive", "extracts", "sess-1");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await mkdir(indexedDir, { recursive: true });
    await mkdir(sidecarDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });

    const notePath = path.join(indexedDir, "202603230100-solving-distill-failure.md");
    await writeFile(
      notePath,
      [
        "---",
        "key: solving-distill-failure",
        "type: decision",
        "project: ",
        "sessionId: sess-1",
        "createdAt: 2026-03-23T01:00:00.000Z",
        "updatedAt: 2026-03-23T01:05:00.000Z",
        "lastSeenAt: 2026-03-23T01:05:00.000Z",
        "sourcePath: sess-1.jsonl.reset.2026-03-23T01-00-00Z",
        "sourceRange: turns 1-3",
        "sourceSessions:",
        "  - sess-1",
        "sidecarPath: memory/archive/extracts/sess-1/solving-distill-failure.md",
        "tags:",
        "  - openclaw",
        "---",
        "",
        "# Solving Distill Failure",
        "",
        "- Summary: Resolved the distill failure by configuring the provider key.",
        "- Why it matters: Restores memory distillation on the server.",
        "- Evidence:",
        "  - Added SILICONFLOW_API_KEY to .env",
        "",
        "## Source Anchors",
        "- turns 1-2 | jsonl L2-L3 | msgIds: msg-1, msg-2 | source: sess-1.jsonl.reset.2026-03-23T01-00-00Z",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(sidecarDir, "solving-distill-failure.md"),
      [
        "---",
        "key: solving-distill-failure",
        "type: decision",
        "project: ",
        "sessionId: sess-1",
        "createdAt: 2026-03-23T01:00:00.000Z",
        "updatedAt: 2026-03-23T01:05:00.000Z",
        "lastSeenAt: 2026-03-23T01:05:00.000Z",
        "sourcePath: sess-1.jsonl.reset.2026-03-23T01-00-00Z",
        "sourceRange: turns 1-3",
        "sourceSessions:",
        "  - sess-1",
        "tags:",
        "  - openclaw",
        "---",
        "",
        "# Solving Distill Failure Sidecar",
        "",
        "- Summary: Resolved the distill failure by configuring the provider key.",
        "",
        "## Full Source Anchors",
        "- turns 1-2 | jsonl L2-L3 | msgIds: msg-1, msg-2 | source: sess-1.jsonl.reset.2026-03-23T01-00-00Z | excerpt: SILICONFLOW_API_KEY set in .env",
        "",
        "## Excerpt Blocks",
        '- "SILICONFLOW_API_KEY set in .env"',
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(sessionsDir, "sess-1.jsonl.reset.2026-03-23T01-00-00Z"),
      makeSessionTranscript([
        { type: "session", id: "sess-1" },
        {
          type: "message",
          id: "msg-1",
          message: { role: "user", content: [{ type: "text", text: "Please fix the distill failure." }] },
        },
        {
          type: "message",
          id: "msg-2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Added SILICONFLOW_API_KEY to .env and restarted the gateway." }],
          },
        },
      ]),
      "utf8",
    );

    const tool = createMemoryExpandToolOrThrow({ config: makeConfig(workspaceDir) });
    const result = await tool.execute("expand_1", {
      path: "memory/indexed/decisions/202603230100-solving-distill-failure.md",
    });
    const details = result.details as {
      note: { title: string; sidecarPath: string | null };
      sidecar: { path: string; text: string; loaded: boolean } | null;
      anchors: Array<{ sessionPath: string | null; sliceText: string; excerpt: string }>;
      warnings: string[];
    };

    expect(details.note.title).toBe("Solving Distill Failure");
    expect(details.note.sidecarPath).toBe("memory/archive/extracts/sess-1/solving-distill-failure.md");
    expect(details.sidecar?.loaded).toBe(true);
    expect(details.sidecar?.text).toContain("## Full Source Anchors");
    expect(details.anchors).toHaveLength(1);
    expect(details.anchors[0]?.sessionPath).toBe("sessions/sess-1.jsonl.reset.2026-03-23T01-00-00Z");
    expect(details.anchors[0]?.sliceText).toContain("T0001 L2 User: Please fix the distill failure.");
    expect(details.anchors[0]?.sliceText).toContain("T0002 L3 Assistant: Added SILICONFLOW_API_KEY");
    expect(details.warnings).toEqual([]);
  });

  it("limits sessionQuery lookup to note-linked source sessions", async () => {
    const workspaceDir = await makeTempDir("openclaw-memory-search-workspace-");
    const stateDir = await makeTempDir("openclaw-memory-search-state-");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const indexedDir = path.join(workspaceDir, "memory", "indexed", "facts");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await mkdir(indexedDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });

    await writeFile(
      path.join(indexedDir, "202603230100-config.md"),
      [
        "---",
        "key: config-memory",
        "type: fact",
        "project: ",
        "sessionId: sess-a",
        "createdAt: 2026-03-23T01:00:00.000Z",
        "updatedAt: 2026-03-23T01:05:00.000Z",
        "lastSeenAt: 2026-03-23T01:05:00.000Z",
        "sourcePath: sess-a.jsonl",
        "sourceRange: turns 1-2",
        "sourceSessions:",
        "  - sess-a",
        "tags:",
        "  - openclaw",
        "---",
        "",
        "# Memory Config",
        "",
        "- Summary: Updated the provider config.",
        "- Why it matters: Keeps memory recall working.",
        "- Evidence:",
        "  - memory.backend = qmd",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(sessionsDir, "sess-a.jsonl"),
      makeSessionTranscript([
        { type: "session", id: "sess-a" },
        {
          type: "message",
          id: "msg-a1",
          message: { role: "user", content: [{ type: "text", text: "Please rotate the token unlock config." }] },
        },
        {
          type: "message",
          id: "msg-a2",
          message: { role: "assistant", content: [{ type: "text", text: "token unlock is now enabled for recall." }] },
        },
      ]),
      "utf8",
    );
    await writeFile(
      path.join(sessionsDir, "sess-b.jsonl"),
      makeSessionTranscript([
        { type: "session", id: "sess-b" },
        {
          type: "message",
          id: "msg-b1",
          message: { role: "assistant", content: [{ type: "text", text: "token unlock only appears here." }] },
        },
      ]),
      "utf8",
    );

    const tool = createMemoryExpandToolOrThrow({ config: makeConfig(workspaceDir) });
    const result = await tool.execute("expand_2", {
      path: "memory/indexed/facts/202603230100-config.md",
      sessionQuery: "token unlock",
      maxSessionHits: 2,
    });
    const details = result.details as {
      sessionSearch: {
        query: string;
        searched: string[];
        results: Array<{ sessionPath: string; snippet: string }>;
      } | null;
      warnings: string[];
    };

    expect(details.sessionSearch?.query).toBe("token unlock");
    expect(details.sessionSearch?.searched).toEqual(["sessions/sess-a.jsonl"]);
    expect(details.sessionSearch?.results).toHaveLength(1);
    expect(details.sessionSearch?.results[0]?.sessionPath).toBe("sessions/sess-a.jsonl");
    expect(details.sessionSearch?.results[0]?.snippet).toContain("token unlock is now enabled for recall");
    expect(details.sessionSearch?.results[0]?.snippet).not.toContain("only appears here");
    expect(details.warnings).toEqual([]);
  });
});
