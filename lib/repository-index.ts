import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import tar from "tar-stream";

const DEFAULT_REPOSITORY = "clb1015/GenMusBot";
const DEFAULT_REF = "main";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_ROOTS = ["curriculum/", "resources/", "metadata/"] as const;

export type KnowledgeDocument = {
  path: string;
  content: string;
  lines: string[];
};

export type KnowledgeSection = {
  path: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  text: string;
  normalized: string;
};

export type KnowledgeIndex = {
  repository: string;
  ref: string;
  loadedAt: string;
  documents: Map<string, KnowledgeDocument>;
  sections: KnowledgeSection[];
};

let cache: { expiresAt: number; promise: Promise<KnowledgeIndex> } | undefined;

function repositoryConfig() {
  const repository = process.env.GENMUSBOT_GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const ref = process.env.GENMUSBOT_GITHUB_REF || DEFAULT_REF;
  const token = process.env.GENMUSBOT_GITHUB_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GENMUSBOT_GITHUB_REPOSITORY must use owner/repository format.");
  }
  return { repository, ref, token };
}

function allowedPath(path: string) {
  return path.endsWith(".md") && ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

function normalize(text: string) {
  return text
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9#./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripArchivePrefix(path: string) {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(slash + 1);
}

async function downloadMarkdownFiles() {
  const { repository, ref, token } = repositoryConfig();
  const url = token
    ? `https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(ref)}`
    : `https://codeload.github.com/${repository}/tar.gz/${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "genmusbot-knowledge-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GitHub archive request failed (${response.status} ${response.statusText}).`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const extract = tar.extract();
  const documents = new Map<string, KnowledgeDocument>();

  const completed = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const path = stripArchivePrefix(header.name);
      if (header.type !== "file" || !allowedPath(path)) {
        stream.resume();
        stream.once("end", next);
        return;
      }

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      });
      stream.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
        documents.set(path, { path, content, lines: content.split("\n") });
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });

  Readable.from(archive).pipe(createGunzip()).pipe(extract);
  await completed;
  if (documents.size === 0) throw new Error("No Markdown knowledge documents were found.");
  return { repository, ref, documents };
}

function splitDocument(document: KnowledgeDocument): KnowledgeSection[] {
  const headings: Array<{ line: number; level: number; text: string }> = [];
  document.lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ line: index, level: match[1].length, text: match[2] });
  });

  if (headings.length === 0) {
    return chunkSection(document.path, "Document", 1, 0, document.lines.length - 1, document.lines);
  }

  const sections: KnowledgeSection[] = [];
  if (headings[0].line > 0) {
    sections.push(...chunkSection(document.path, "Introduction", 1, 0, headings[0].line - 1, document.lines));
  }
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    const endLine = next ? next.line - 1 : document.lines.length - 1;
    sections.push(...chunkSection(document.path, heading.text, heading.level, heading.line, endLine, document.lines));
  });
  return sections;
}

function chunkSection(
  path: string,
  heading: string,
  level: number,
  startLine: number,
  endLine: number,
  lines: string[],
) {
  const maxLines = 100;
  const chunks: KnowledgeSection[] = [];
  for (let start = startLine; start <= endLine; start += maxLines) {
    const end = Math.min(endLine, start + maxLines - 1);
    const text = lines.slice(start, end + 1).join("\n").trim();
    if (!text) continue;
    chunks.push({
      path,
      heading: start === startLine ? heading : `${heading} (continued)`,
      level,
      startLine: start + 1,
      endLine: end + 1,
      text,
      normalized: normalize(`${path} ${heading} ${text}`),
    });
  }
  return chunks;
}

async function buildIndex(): Promise<KnowledgeIndex> {
  const { repository, ref, documents } = await downloadMarkdownFiles();
  const sections = [...documents.values()].flatMap(splitDocument);
  return { repository, ref, loadedAt: new Date().toISOString(), documents, sections };
}

export async function getKnowledgeIndex() {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    cache = { expiresAt: now + CACHE_TTL_MS, promise: buildIndex() };
    cache.promise.catch(() => {
      cache = undefined;
    });
  }
  return cache.promise;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "what", "when", "with",
]);

function queryTerms(query: string) {
  return normalize(query).split(" ").filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

function occurrenceCount(text: string, term: string) {
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(term, at)) !== -1) {
    count += 1;
    at += term.length;
  }
  return count;
}

function snippetFor(section: KnowledgeSection, terms: string[]) {
  const lower = section.text.toLocaleLowerCase("en-US");
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 240);
  const end = Math.min(section.text.length, start + 900);
  return `${start > 0 ? "…" : ""}${section.text.slice(start, end).trim()}${end < section.text.length ? "…" : ""}`;
}

export async function searchKnowledge(args: {
  query: string;
  gradeLevel?: string;
  roots?: string[];
  limit?: number;
}) {
  const index = await getKnowledgeIndex();
  const terms = queryTerms(args.query);
  if (!terms.length) throw new Error("Search query must include at least one meaningful term.");
  const phrase = normalize(args.query);
  const requestedRoots = (args.roots || []).filter((root) => ALLOWED_ROOTS.includes(root as (typeof ALLOWED_ROOTS)[number]));
  const grade = args.gradeLevel ? normalize(args.gradeLevel) : "";

  const scored = index.sections.flatMap((section) => {
    if (requestedRoots.length && !requestedRoots.some((root) => section.path.startsWith(root))) return [];
    if (grade && !section.normalized.includes(grade)) {
      const gradePathHints: Record<string, string[]> = {
        kindergarten: ["kindergarten", "grade-k"],
        "grade 1": ["grade-1", "first grade"],
        "grade 2": ["grade-2", "second grade"],
        "grade 3": ["grade-3", "third grade"],
        "grade 4": ["grade-4", "fourth grade"],
        "grade 5": ["grade-5", "fifth grade"],
      };
      const hints = gradePathHints[grade] || [grade];
      if (!hints.some((hint) => section.normalized.includes(hint))) return [];
    }

    const heading = normalize(section.heading);
    const path = normalize(section.path);
    const matchedTerms = terms.filter((term) => section.normalized.includes(term));
    if (!matchedTerms.length) return [];
    let score = matchedTerms.length * 12;
    score += matchedTerms.reduce((sum, term) => sum + Math.min(occurrenceCount(section.normalized, term), 8), 0);
    score += matchedTerms.filter((term) => heading.includes(term)).length * 8;
    score += matchedTerms.filter((term) => path.includes(term)).length * 5;
    if (phrase.length > 3 && section.normalized.includes(phrase)) score += 20;
    if (matchedTerms.length === terms.length) score += 15;
    if (section.path.startsWith("curriculum/")) score += 3;
    return [{ section, score, matchedTerms }];
  });

  scored.sort((a, b) => b.score - a.score || a.section.path.localeCompare(b.section.path));
  return {
    repository: index.repository,
    ref: index.ref,
    indexed_at: index.loadedAt,
    results: scored.slice(0, args.limit || 8).map(({ section, score, matchedTerms }) => ({
      path: section.path,
      section: section.heading,
      lines: `${section.startLine}-${section.endLine}`,
      score,
      matched_terms: matchedTerms,
      snippet: snippetFor(section, matchedTerms),
    })),
  };
}

function assertSafeKnowledgePath(path: string) {
  if (path.includes("..") || path.startsWith("/") || !allowedPath(path)) {
    throw new Error("Path must be a Markdown file under curriculum/, resources/, or metadata/.");
  }
}

export async function fetchKnowledge(args: {
  path: string;
  section?: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}) {
  assertSafeKnowledgePath(args.path);
  const index = await getKnowledgeIndex();
  const document = index.documents.get(args.path);
  if (!document) throw new Error(`Knowledge document not found: ${args.path}`);
  const maxChars = Math.min(Math.max(args.maxChars || 8000, 500), 12000);

  let start = Math.max((args.startLine || 1) - 1, 0);
  let end = Math.min(args.endLine || document.lines.length, document.lines.length);
  let matchedSection: string | undefined;

  if (args.section) {
    const wanted = normalize(args.section);
    const candidates = index.sections.filter((item) => item.path === args.path && !item.heading.endsWith("(continued)"));
    const exact = candidates.find((item) => normalize(item.heading) === wanted);
    const partial = candidates.find((item) => normalize(item.heading).includes(wanted));
    const match = exact || partial;
    if (!match) {
      return {
        repository: index.repository,
        ref: index.ref,
        path: args.path,
        error: `Section not found: ${args.section}`,
        available_sections: candidates.slice(0, 80).map((item) => ({ heading: item.heading, line: item.startLine })),
      };
    }
    start = match.startLine - 1;
    const next = candidates.find((item) => item.startLine > match.startLine && item.level <= match.level);
    end = next ? next.startLine - 1 : document.lines.length;
    matchedSection = match.heading;
  }

  const content = document.lines.slice(start, end).join("\n");
  const truncated = content.length > maxChars;
  const result = truncated ? content.slice(0, maxChars).trimEnd() : content;
  return {
    repository: index.repository,
    ref: index.ref,
    path: args.path,
    section: matchedSection,
    lines: `${start + 1}-${end}`,
    truncated,
    content: result,
    ...(truncated ? { continuation: { start_line: start + result.split("\n").length, max_chars: maxChars } } : {}),
  };
}

export function clearKnowledgeCacheForTests() {
  cache = undefined;
}
