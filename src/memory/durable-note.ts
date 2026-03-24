export type DurableSourceAnchor = {
  sourcePath: string | null;
  turnStart: number | null;
  turnEnd: number | null;
  messageIds: string[];
  jsonlLineStart: number | null;
  jsonlLineEnd: number | null;
  excerpt: string;
};

export type ParsedDurableNote = {
  key: string | null;
  title: string;
  summary: string;
  whyItMatters: string;
  sourcePath: string | null;
  sourceSessions: string[];
  sidecarPath: string | null;
  sourceAnchors: DurableSourceAnchor[];
  keyExcerpts: string[];
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function trimInline(value: unknown, maxChars = 280): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function dedupeStrings(values: unknown[], maxChars = 280): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = trimInline(raw, maxChars);
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string | string[]>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const [, header, body] = match;
  const frontmatter: Record<string, string | string[]> = {};
  let arrayKey: string | null = null;
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (keyMatch) {
      const [, key, value] = keyMatch;
      if (!value) {
        frontmatter[key] = [];
        arrayKey = key;
      } else {
        frontmatter[key] = value.trim();
        arrayKey = null;
      }
      continue;
    }
    const itemMatch = /^\s*-\s*(.+)$/.exec(line);
    if (itemMatch && arrayKey) {
      const existing = frontmatter[arrayKey];
      const next = Array.isArray(existing) ? existing : [];
      next.push(itemMatch[1].trim());
      frontmatter[arrayKey] = next;
    }
  }
  return { frontmatter, body };
}

function bulletListFromSection(body: string, heading: string): string[] {
  const headingMatch = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(body);
  if (!headingMatch) {
    return [];
  }
  const remaining = body.slice(headingMatch.index + headingMatch[0].length).replace(/^\r?\n/, "");
  const nextHeadingIndex = remaining.search(/^##\s+/m);
  const block = nextHeadingIndex === -1 ? remaining : remaining.slice(0, nextHeadingIndex);
  return block
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*(.+)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function bulletListFromLeadLabel(body: string, label: string): string[] {
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `- ${label}:`);
  if (startIndex === -1) {
    return [];
  }
  const items: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const bulletMatch = /^\s*-\s*(.+)$/.exec(line);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
      continue;
    }
    if (!line.trim()) {
      if (items.length > 0) {
        break;
      }
      continue;
    }
    break;
  }
  return items;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseDurableSourceAnchorLine(line: string): DurableSourceAnchor | null {
  const value = trimInline(line, 800);
  if (!value) {
    return null;
  }
  const anchor: DurableSourceAnchor = {
    sourcePath: null,
    turnStart: null,
    turnEnd: null,
    messageIds: [],
    jsonlLineStart: null,
    jsonlLineEnd: null,
    excerpt: "",
  };
  for (const part of value.split(/\s+\|\s+/)) {
    let match = /^turns\s+(\d+)-(\d+)$/i.exec(part);
    if (match) {
      anchor.turnStart = parsePositiveInt(match[1]);
      anchor.turnEnd = parsePositiveInt(match[2]) ?? anchor.turnStart;
      continue;
    }
    match = /^jsonl\s+L(\d+)-L(\d+)$/i.exec(part);
    if (match) {
      anchor.jsonlLineStart = parsePositiveInt(match[1]);
      anchor.jsonlLineEnd = parsePositiveInt(match[2]) ?? anchor.jsonlLineStart;
      continue;
    }
    match = /^msgIds:\s*(.+)$/i.exec(part);
    if (match) {
      anchor.messageIds = dedupeStrings(match[1].split(/\s*,\s*/), 80);
      continue;
    }
    match = /^source:\s*(.+)$/i.exec(part);
    if (match) {
      anchor.sourcePath = trimInline(match[1], 240) || null;
      continue;
    }
    match = /^excerpt:\s*(.+)$/i.exec(part);
    if (match) {
      anchor.excerpt = trimInline(match[1], 220);
    }
  }
  if (!anchor.turnStart && !anchor.jsonlLineStart && anchor.messageIds.length === 0 && !anchor.sourcePath) {
    return null;
  }
  return anchor;
}

export function parseDurableNote(raw: string): ParsedDurableNote {
  const { frontmatter, body } = parseFrontmatter(raw);
  const normalizedBody = normalizeWhitespace(body);
  const titleMatch = normalizedBody.match(/^#\s+(.+)$/m);
  const summaryMatch = normalizedBody.match(/^- Summary:\s*(.+)$/m);
  const whyMatch = normalizedBody.match(/^- Why it matters:\s*(.+)$/m);
  const sourceSessions = frontmatter.sourceSessions;
  return {
    key: typeof frontmatter.key === "string" && frontmatter.key.trim() ? frontmatter.key.trim() : null,
    title: trimInline(titleMatch?.[1] ?? "", 160),
    summary: trimInline(summaryMatch?.[1] ?? "", 320),
    whyItMatters: trimInline(whyMatch?.[1] ?? "", 320),
    sourcePath:
      typeof frontmatter.sourcePath === "string" && frontmatter.sourcePath.trim()
        ? frontmatter.sourcePath.trim()
        : null,
    sourceSessions: Array.isArray(sourceSessions) ? dedupeStrings(sourceSessions, 120) : [],
    sidecarPath:
      typeof frontmatter.sidecarPath === "string" && frontmatter.sidecarPath.trim()
        ? frontmatter.sidecarPath.trim()
        : null,
    sourceAnchors: dedupeStrings(
      [
        ...bulletListFromSection(normalizedBody, "Source Anchors"),
        ...bulletListFromSection(normalizedBody, "Full Source Anchors"),
      ],
      800,
    )
      .map((line) => parseDurableSourceAnchorLine(line))
      .filter((anchor): anchor is DurableSourceAnchor => Boolean(anchor)),
    keyExcerpts: dedupeStrings(
      [
        ...bulletListFromSection(normalizedBody, "Key Excerpts"),
        ...bulletListFromSection(normalizedBody, "Excerpt Blocks"),
        ...bulletListFromLeadLabel(normalizedBody, "Evidence"),
      ].map((entry) => entry.replace(/^["']+|["']+$/g, "").trim()),
      220,
    ),
  };
}
