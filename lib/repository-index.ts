import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import tar from "tar-stream";

const DEFAULT_REPOSITORY = "clb1015/GenMusBot";
const DEFAULT_REF = "main";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_ROOTS = ["curriculum/", "resources/", "metadata/"] as const;
const TARGET_CHUNK_TOKENS = 800;
const MAX_CHUNK_TOKENS = 1000;
const OVERLAP_TOKENS = 125;

export type KnowledgeDocument = { path: string; content: string; lines: string[] };
export type KnowledgeMetadata = {
  grade?: string;
  sourceGroup: string;
  sourcePriority: number;
  concepts: string[];
  activityTypes: string[];
  repertoire: string[];
  standards: string[];
  quarter?: string;
  unit?: string;
};
export type KnowledgeSection = KnowledgeMetadata & {
  path: string;
  heading: string;
  level: number;
  activity?: string;
  label: string;
  startLine: number;
  endLine: number;
  text: string;
  normalized: string;
  tokenEstimate: number;
};
export type KnowledgeIndex = {
  repository: string;
  ref: string;
  loadedAt: string;
  documents: Map<string, KnowledgeDocument>;
  sections: KnowledgeSection[];
};

type Frontmatter = Record<string, string>;
type Block = { heading: string; level: number; activity?: string; startLine: number; endLine: number; lines: string[] };
type Unit = { startLine: number; endLine: number; lines: string[]; tokens: number };
type SearchPass = "district_curriculum" | "grade_specific_gameplan" | "approved_supplemental" | "requested_roots";
type SearchArgs = { query: string; gradeLevel?: string; roots?: string[]; limit?: number };
type ScoredSection = { section: KnowledgeSection; score: number; matchedTerms: string[]; pass: SearchPass };

let cache: { expiresAt: number; promise: Promise<KnowledgeIndex> } | undefined;

const CONCEPTS: Record<string, string[]> = {
  form: ["form", "musical form", "structure", "section", "sections", "ab form", "aba", "aaba", "refrain", "verse", "chorus", "repeated pattern", "repeated section", "contrasting section", "returns", "returning", "comes back", "same musical idea"],
  melody: ["melody", "melodic", "pitch", "pitches", "melodic contour", "high and low", "solfege", "sol fa", "do re mi", "s l m r d", "tune"],
  rhythm: ["rhythm", "rhythmic", "steady beat", "beat", "note values", "duration", "quarter note", "eighth note", "rest", "rests", "ta", "ti ti"],
  ostinato: ["ostinato", "repeated pattern", "repeating pattern", "riff", "bordun", "drone"],
  meter: ["meter", "metre", "meter sign", "time signature", "duple", "triple", "2 4", "3 4", "4 4", "beats per measure"],
  dynamics: ["dynamics", "dynamic", "loud", "soft", "forte", "piano", "crescendo", "decrescendo", "volume"],
  tempo: ["tempo", "fast", "slow", "speed", "accelerando", "ritardando"],
  timbre: ["timbre", "tone color", "sound quality", "instrument family", "woodwinds", "brass", "strings", "percussion"],
  harmony: ["harmony", "harmonic", "chord", "chords", "triad", "triads", "accompaniment", "bordun", "drone"],
  notation: ["notation", "notate", "notated", "staff", "treble clef", "music reading", "read music", "score", "symbol", "symbols", "rhythm cards"],
  movement: ["movement", "move", "moving", "dance", "locomotor", "nonlocomotor", "gesture", "body percussion", "choreograph"],
  recorder: ["recorder", "soprano recorder", "b a g", "bag"],
  improvisation: ["improvisation", "improvise", "improvising", "exploration", "explore", "compose", "composition", "create music"],
};
const ACTIVITY_TYPES: Record<string, string[]> = {
  singing: ["sing", "singing", "echo sing", "voice", "song"],
  playing: ["play", "playing", "instrument", "percussion", "recorder", "mallet"],
  movement: CONCEPTS.movement,
  listening: ["listen", "listening", "aural", "hear"],
  literacy: ["read", "reading", "notation", "notate", "staff", "score", "dictation"],
  composing: ["compose", "composition", "create", "improvise", "improvisation"],
  assessment: ["assessment", "assess", "formative", "summative", "check for understanding"],
};

function repositoryConfig() {
  const repository = process.env.GENMUSBOT_GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const ref = process.env.GENMUSBOT_GITHUB_REF || DEFAULT_REF;
  const token = process.env.GENMUSBOT_GITHUB_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GENMUSBOT_GITHUB_REPOSITORY must use owner/repository format.");
  return { repository, ref, token };
}
function allowedPath(path: string) { return path.endsWith(".md") && ALLOWED_ROOTS.some((root) => path.startsWith(root)); }
function normalize(text: string) {
  return text.toLocaleLowerCase("en-US").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9#./ -]+/g, " ").replace(/\s+/g, " ").trim();
}
function hasTerm(text: string, term: string) {
  const normalizedTerm = normalize(term);
  return Boolean(normalizedTerm) && ` ${text} `.includes(` ${normalizedTerm} `);
}
function estimateTokens(text: string) { return Math.max(1, Math.ceil(text.length / 4)); }
function unique(values: string[]) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

async function downloadMarkdownFiles() {
  const { repository, ref, token } = repositoryConfig();
  const url = token ? `https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(ref)}` : `https://codeload.github.com/${repository}/tar.gz/${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "genmusbot-knowledge-mcp", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
  if (!response.ok) throw new Error(`GitHub archive request failed (${response.status} ${response.statusText}).`);
  const extract = tar.extract();
  const documents = new Map<string, KnowledgeDocument>();
  const completed = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const slash = header.name.indexOf("/");
      const path = slash === -1 ? "" : header.name.slice(slash + 1);
      if (header.type !== "file" || !allowedPath(path)) { stream.resume(); stream.once("end", next); return; }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)));
      stream.on("end", () => { const content = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n"); documents.set(path, { path, content, lines: content.split("\n") }); next(); });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  Readable.from(Buffer.from(await response.arrayBuffer())).pipe(createGunzip()).pipe(extract);
  await completed;
  if (!documents.size) throw new Error("No Markdown knowledge documents were found.");
  return { repository, ref, documents };
}

function parseFrontmatter(lines: string[]): { values: Frontmatter; contentStart: number } {
  if (lines[0]?.trim() !== "---") return { values: {}, contentStart: 0 };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return { values: {}, contentStart: 0 };
  const values: Frontmatter = {};
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { values, contentStart: closing + 1 };
}
function displayGrade(value: string | undefined, path: string) {
  const normalized = normalize(value || "");
  if (normalized === "kindergarten" || path.includes("kindergarten")) return "Kindergarten";
  const match = /(?:grade |grade-)([1-5])\b/.exec(normalized) || /grade-([1-5])\b/.exec(path);
  return match ? `Grade ${match[1]}` : undefined;
}
function inferSource(path: string, frontmatter: Frontmatter) {
  const priority = Number(frontmatter.priority);
  const configured = Number.isFinite(priority) ? priority : undefined;
  if (path.startsWith("curriculum/")) return { sourceGroup: "SDOC Elementary Music Curriculum", sourcePriority: configured ?? 100 };
  if (path.startsWith("resources/gameplan/")) return { sourceGroup: "GamePlan", sourcePriority: configured ?? 90 };
  const groups: Array<[string, string]> = [["resources/almeida/", "Almeida resources"], ["resources/fahmie/", "Fahmie lessons"], ["resources/kodaly/", "Kodály resources"], ["resources/orff/", "Orff-Schulwerk resources"], ["resources/poems-books/", "Poems and Books resources"], ["resources/sandy-lantz/", "Sandy Lantz resource"]];
  const group = groups.find(([prefix]) => path.startsWith(prefix))?.[1];
  if (group || path.startsWith("resources/")) return { sourceGroup: group || "Approved supplemental resources", sourcePriority: configured ?? 80 };
  return { sourceGroup: "GenMusBot metadata", sourcePriority: configured ?? 10 };
}
function isActivityBoundary(line: string) {
  return /^(?:\d+[.)]\s+|activity\s*(?:#?\d+|:)|lesson\s+(?:\d+|one|two|three|four|five)|week\s+(?:\d+|one|two|three|four|five)|unit\s+(?:q[1-4]\s*)?(?:unit\s*)?\d*\s*:)/i.test(line.trim());
}
function structuralBlocks(document: KnowledgeDocument, contentStart: number): Block[] {
  const blocks: Block[] = [];
  let heading = "Document", level = 1, activity: string | undefined, start = contentStart, buffer: string[] = [];
  const flush = (endLine: number) => { if (buffer.some((line) => line.trim())) blocks.push({ heading, level, activity, startLine: start + 1, endLine: endLine + 1, lines: buffer }); buffer = []; };
  for (let index = contentStart; index < document.lines.length; index += 1) {
    const line = document.lines[index];
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) { flush(index - 1); heading = headingMatch[2]; level = headingMatch[1].length; activity = undefined; start = index; buffer = [line]; continue; }
    if (isActivityBoundary(line) && buffer.some((item) => item.trim())) {
      const onlyHeading = buffer.length === 1 && /^(#{1,6})\s+/.test(buffer[0]);
      if (!onlyHeading) { flush(index - 1); start = index; buffer = []; }
      activity = line.trim();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush(document.lines.length - 1);
  return blocks;
}
function splitOversizedUnit(unit: Unit): Unit[] {
  if (unit.tokens <= MAX_CHUNK_TOKENS) return [unit];
  const pieces: Unit[] = [];
  let startLine = unit.startLine, current: string[] = [], currentTokens = 0;
  const flush = (endLine: number) => { if (current.length) pieces.push({ startLine, endLine, lines: current, tokens: currentTokens }); current = []; currentTokens = 0; };
  unit.lines.forEach((line, index) => { const tokens = estimateTokens(line), lineNumber = unit.startLine + index; if (current.length && currentTokens + tokens > TARGET_CHUNK_TOKENS) { flush(lineNumber - 1); startLine = lineNumber; } current.push(line); currentTokens += tokens; });
  flush(unit.endLine);
  return pieces;
}
function contentUnits(block: Block): Unit[] {
  const units: Unit[] = [];
  let current: string[] = [], startLine = block.startLine;
  const flush = (endLine: number) => { if (current.some((line) => line.trim())) { const unit = { startLine, endLine, lines: current, tokens: estimateTokens(current.join("\n")) }; units.push(...splitOversizedUnit(unit)); } current = []; };
  block.lines.forEach((line, index) => { const lineNumber = block.startLine + index; if (!line.trim() && current.length) { current.push(line); flush(lineNumber); startLine = lineNumber + 1; return; } if (!current.length) startLine = lineNumber; current.push(line); });
  flush(block.endLine);
  return units;
}
function overlapTail(units: Unit[]) {
  const tail: Unit[] = []; let tokens = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) { const unit = units[index]; if (tokens && tokens + unit.tokens > OVERLAP_TOKENS + 25) break; tail.unshift(unit); tokens += unit.tokens; if (tokens >= OVERLAP_TOKENS - 25) break; }
  return tail;
}
function conceptsFor(text: string) { const normalized = normalize(text); return Object.entries(CONCEPTS).filter(([, terms]) => terms.some((term) => hasTerm(normalized, term))).map(([concept]) => concept); }
function activityTypesFor(text: string) { const normalized = normalize(text); return Object.entries(ACTIVITY_TYPES).filter(([, terms]) => terms.some((term) => hasTerm(normalized, term))).map(([type]) => type); }
function repertoireFor(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:songs?|repertoire|book)\s*:\s*([^\n]+)/gi)) for (const quoted of match[1].matchAll(/["“]([^"”]{2,100})["”]/g)) found.push(quoted[1]);
  for (const quoted of text.matchAll(/["“]([^"”]{2,80})["”]/g)) found.push(quoted[1]);
  return unique(found).slice(0, 8);
}
function standardsFor(text: string) { return unique([...text.matchAll(/\bMU\.\d+\.[A-Z]\.?\d*\.\d+\b/gi)].map((match) => match[0].toUpperCase())); }
function pacingFor(text: string) { const quarter = /\b(?:quarter\s*|q)([1-4])\b/i.exec(text)?.[1]; const unit = /^\s*unit\s+([^\n]+)/im.exec(text)?.[1]?.trim(); return { quarter: quarter ? `Q${quarter}` : undefined, unit }; }
function chunksForBlock(block: Block, document: KnowledgeDocument, frontmatter: Frontmatter): KnowledgeSection[] {
  const units = contentUnits(block), chunks: Array<{ units: Unit[]; startLine: number; endLine: number }> = [];
  let current: Unit[] = [], currentTokens = 0;
  const flush = () => { if (current.length) chunks.push({ units: current, startLine: current[0].startLine, endLine: current.at(-1)!.endLine }); current = []; currentTokens = 0; };
  for (const unit of units) { if (current.length && currentTokens + unit.tokens > MAX_CHUNK_TOKENS) { const prior = current; flush(); current = overlapTail(prior); currentTokens = current.reduce((sum, item) => sum + item.tokens, 0); } current.push(unit); currentTokens += unit.tokens; }
  flush();
  const source = inferSource(document.path, frontmatter), grade = displayGrade(frontmatter.grade, document.path);
  return chunks.map((chunk, index) => {
    const text = chunk.units.map((unit) => unit.lines.join("\n")).join("\n").trim();
    const descriptor = block.activity ? `${block.heading} — ${block.activity}` : block.heading;
    const metadataText = `${frontmatter.approach || ""}\n${block.heading}\n${block.activity || ""}\n${text}`;
    return { path: document.path, heading: block.heading, level: block.level, activity: block.activity, label: chunks.length > 1 ? `${descriptor} (part ${index + 1})` : descriptor, startLine: chunk.startLine, endLine: chunk.endLine, text, normalized: normalize(`${document.path} ${frontmatter.source_title || ""} ${metadataText}`), tokenEstimate: estimateTokens(text), grade, ...source, concepts: conceptsFor(metadataText), activityTypes: activityTypesFor(metadataText), repertoire: repertoireFor(text), standards: standardsFor(text), ...pacingFor(text) };
  });
}
export function splitKnowledgeDocument(document: KnowledgeDocument): KnowledgeSection[] { const { values, contentStart } = parseFrontmatter(document.lines); return structuralBlocks(document, contentStart).flatMap((block) => chunksForBlock(block, document, values)); }
function buildIndexFromDocuments(documents: Map<string, KnowledgeDocument>, repository: string, ref: string): KnowledgeIndex { return { repository, ref, loadedAt: new Date().toISOString(), documents, sections: [...documents.values()].flatMap(splitKnowledgeDocument) }; }
async function buildIndex(): Promise<KnowledgeIndex> { const { repository, ref, documents } = await downloadMarkdownFiles(); return buildIndexFromDocuments(documents, repository, ref); }
export async function getKnowledgeIndex() { const now = Date.now(); if (!cache || cache.expiresAt <= now) { cache = { expiresAt: now + CACHE_TTL_MS, promise: buildIndex() }; cache.promise.catch(() => { cache = undefined; }); } return cache.promise; }

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "when", "with"]);
function queryTerms(query: string) { return normalize(query).split(" ").filter((term) => term.length > 1 && !STOP_WORDS.has(term)); }
function expandedQuery(query: string) {
  const normalized = normalize(query), concepts = Object.entries(CONCEPTS).filter(([, terms]) => terms.some((term) => hasTerm(normalized, term))).map(([concept]) => concept);
  return { originalTerms: queryTerms(query), expandedTerms: unique([...queryTerms(query), ...concepts.flatMap((concept) => CONCEPTS[concept])]), concepts };
}
function occurrenceCount(text: string, term: string) { const needle = ` ${normalize(term)} `, padded = ` ${text} `; let count = 0, at = 0; while ((at = padded.indexOf(needle, at)) !== -1) { count += 1; at += needle.length; } return count; }
function snippetFor(section: KnowledgeSection, terms: string[]) { const normalized = normalize(section.text), positions = terms.map((term) => normalized.indexOf(normalize(term))).filter((position) => position >= 0), first = positions.length ? Math.min(...positions) : 0, start = Math.max(0, first - 240), end = Math.min(section.text.length, start + 900); return `${start ? "…" : ""}${section.text.slice(start, end).trim()}${end < section.text.length ? "…" : ""}`; }
function gradeMatches(section: KnowledgeSection, requestedGrade: string, strict: boolean) {
  if (!requestedGrade) return true;
  const requested = displayGrade(requestedGrade, requestedGrade) || requestedGrade;
  if (section.grade === requested || !strict) return true;
  const hints: Record<string, string[]> = { kindergarten: ["kindergarten", "grade k"], "grade 1": ["grade 1", "first grade", "grade-1"], "grade 2": ["grade 2", "second grade", "grade-2"], "grade 3": ["grade 3", "third grade", "grade-3"], "grade 4": ["grade 4", "fourth grade", "grade-4"], "grade 5": ["grade 5", "fifth grade", "grade-5"] };
  return (hints[normalize(requestedGrade)] || [normalize(requestedGrade)]).some((hint) => hasTerm(section.normalized, hint));
}
function passForPath(path: string, rootsRequested: boolean): SearchPass { if (rootsRequested) return "requested_roots"; if (path.startsWith("curriculum/")) return "district_curriculum"; if (path.startsWith("resources/gameplan/")) return "grade_specific_gameplan"; return "approved_supplemental"; }
function passOrder(rootsRequested: boolean): SearchPass[] { return rootsRequested ? ["requested_roots"] : ["district_curriculum", "grade_specific_gameplan", "approved_supplemental"]; }
function scoreSections(index: KnowledgeIndex, args: SearchArgs) {
  const { originalTerms, expandedTerms, concepts } = expandedQuery(args.query);
  if (!originalTerms.length) throw new Error("Search query must include at least one meaningful term.");
  const requestedRoots = (args.roots || []).filter((root) => ALLOWED_ROOTS.includes(root as (typeof ALLOWED_ROOTS)[number])), rootsRequested = requestedRoots.length > 0, grade = args.gradeLevel ? normalize(args.gradeLevel) : "", phrase = normalize(args.query);
  const scored = index.sections.flatMap((section): ScoredSection[] => {
    if (rootsRequested && !requestedRoots.some((root) => section.path.startsWith(root))) return [];
    const pass = passForPath(section.path, rootsRequested), strictGrade = pass === "district_curriculum" || pass === "grade_specific_gameplan" || pass === "requested_roots";
    if (!gradeMatches(section, grade, strictGrade)) return [];
    const matchedTerms = expandedTerms.filter((term) => hasTerm(section.normalized, term));
    if (!matchedTerms.length) return [];
    const originalMatched = originalTerms.filter((term) => hasTerm(section.normalized, term)), heading = normalize(section.heading), path = normalize(section.path);
    let score = originalMatched.length * 18 + matchedTerms.length * 4 + matchedTerms.reduce((sum, term) => sum + Math.min(occurrenceCount(section.normalized, term), 8), 0);
    score += matchedTerms.filter((term) => hasTerm(heading, term)).length * 8 + matchedTerms.filter((term) => hasTerm(path, term)).length * 5;
    if (phrase.length > 3 && hasTerm(section.normalized, phrase)) score += 20;
    if (originalMatched.length === originalTerms.length) score += 15;
    return [{ section, score: score + section.sourcePriority / 20, matchedTerms, pass }];
  });
  return { scored, concepts, expandedTerms, requestedRoots, rootsRequested };
}
function selectMultiPassResults(scored: ScoredSection[], limit: number, rootsRequested: boolean) {
  const order = passOrder(rootsRequested), byPass = new Map(order.map((pass) => [pass, scored.filter((item) => item.pass === pass).sort((a, b) => b.score - a.score || a.section.path.localeCompare(b.section.path))]));
  const selected: ScoredSection[] = [];
  for (const pass of order) { const candidate = byPass.get(pass)?.[0]; if (candidate && selected.length < limit) selected.push(candidate); }
  for (const pass of order) for (const candidate of byPass.get(pass) || []) if (!selected.includes(candidate) && selected.length < limit) selected.push(candidate);
  return { selected, byPass, order };
}
export function searchKnowledgeInIndex(index: KnowledgeIndex, args: SearchArgs) {
  const { scored, concepts, expandedTerms, requestedRoots, rootsRequested } = scoreSections(index, args), limit = Math.min(Math.max(args.limit || 8, 1), 12), { selected, byPass, order } = selectMultiPassResults(scored, limit, rootsRequested);
  const firstPassCount = byPass.get(order[0])?.length || 0, laterPassCount = order.slice(1).reduce((sum, pass) => sum + (byPass.get(pass)?.length || 0), 0);
  return {
    repository: index.repository, ref: index.ref, indexed_at: index.loadedAt, expanded_concepts: concepts, expanded_terms: expandedTerms,
    search_strategy: { passes: order.map((pass) => ({ pass, result_count: byPass.get(pass)?.length || 0 })), ...(firstPassCount === 0 && laterPassCount > 0 ? { broadened_after_empty_first_pass: true } : {}), ...(requestedRoots.length ? { requested_roots: requestedRoots } : {}) },
    results: selected.map(({ section, score, matchedTerms, pass }) => ({ path: section.path, section: section.label, lines: `${section.startLine}-${section.endLine}`, score: Number(score.toFixed(2)), matched_terms: matchedTerms, retrieval_pass: pass, source_group: section.sourceGroup, source_priority: section.sourcePriority, ...(section.grade ? { grade: section.grade } : {}), ...(section.quarter ? { quarter: section.quarter } : {}), ...(section.unit ? { unit: section.unit } : {}), concepts: section.concepts, activity_types: section.activityTypes, repertoire: section.repertoire, standards: section.standards, token_estimate: section.tokenEstimate, snippet: snippetFor(section, matchedTerms) })),
  };
}
export async function searchKnowledge(args: SearchArgs) { return searchKnowledgeInIndex(await getKnowledgeIndex(), args); }

function assertSafeKnowledgePath(path: string) { if (path.includes("..") || path.startsWith("/") || !allowedPath(path)) throw new Error("Path must be a Markdown file under curriculum/, resources/, or metadata/."); }
export async function fetchKnowledge(args: { path: string; section?: string; startLine?: number; endLine?: number; maxChars?: number }) {
  assertSafeKnowledgePath(args.path);
  const index = await getKnowledgeIndex(), document = index.documents.get(args.path);
  if (!document) throw new Error(`Knowledge document not found: ${args.path}`);
  const maxChars = Math.min(Math.max(args.maxChars || 8000, 500), 12000);
  let start = Math.max((args.startLine || 1) - 1, 0), end = Math.min(args.endLine || document.lines.length, document.lines.length), matchedSection: string | undefined;
  if (args.section) {
    const wanted = normalize(args.section), candidates = index.sections.filter((item) => item.path === args.path), match = candidates.find((item) => normalize(item.label) === wanted) || candidates.find((item) => hasTerm(normalize(item.label), wanted));
    if (!match) return { repository: index.repository, ref: index.ref, path: args.path, error: `Section not found: ${args.section}`, available_sections: candidates.slice(0, 80).map((item) => ({ heading: item.label, line: item.startLine })) };
    start = match.startLine - 1; end = match.endLine; matchedSection = match.label;
  }
  const content = document.lines.slice(start, end).join("\n"), truncated = content.length > maxChars, result = truncated ? content.slice(0, maxChars).trimEnd() : content;
  return { repository: index.repository, ref: index.ref, path: args.path, section: matchedSection, lines: `${start + 1}-${end}`, truncated, content: result, ...(truncated ? { continuation: { start_line: start + result.split("\n").length, max_chars: maxChars } } : {}) };
}
export function createKnowledgeIndexForTests(documents: Record<string, string>): KnowledgeIndex {
  const entries = Object.entries(documents).map(([path, content]) => [path, { path, content, lines: content.replace(/\r\n/g, "\n").split("\n") }] as const);
  return buildIndexFromDocuments(new Map(entries), "test/repository", "test");
}
export function clearKnowledgeCacheForTests() { cache = undefined; }
