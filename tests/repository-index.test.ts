import test from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeIndexForTests,
  fetchKnowledge,
  searchKnowledgeInIndex,
  splitKnowledgeDocument,
  type KnowledgeDocument,
} from "../lib/repository-index";

function paragraphs(count: number, wordsPerParagraph: number) {
  return Array.from({ length: count }, (_, paragraph) =>
    Array.from({ length: wordsPerParagraph }, (_, word) => `paragraph${paragraph + 1}word${word + 1}`).join(" "),
  ).join("\n\n");
}

test("rejects paths outside knowledge roots", async () => {
  await assert.rejects(() => fetchKnowledge({ path: "package.json" }), /Path must be a Markdown file/);
});

test("rejects path traversal", async () => {
  await assert.rejects(() => fetchKnowledge({ path: "curriculum/../README.md" }), /Path must be a Markdown file/);
});

test("creates structure-aware, overlapping chunks instead of fixed line windows", () => {
  const content = `---\ngrade: "Grade 3"\n---\n# Long sequence\n${paragraphs(13, 30)}`;
  const document: KnowledgeDocument = { path: "curriculum/grade-3.md", content, lines: content.split("\n") };
  const chunks = splitKnowledgeDocument(document);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].heading, "Long sequence");
  assert.ok(chunks[0].tokenEstimate >= 600 && chunks[0].tokenEstimate <= 1000);
  const overlapMarker = chunks[0].text.match(/paragraph\d+word1/g)?.at(-1);
  assert.ok(overlapMarker);
  assert.ok(chunks[1].text.includes(overlapMarker), "the next chunk carries a paragraph-sized overlap");
  assert.ok(chunks[1].startLine <= chunks[0].endLine, "overlap retains source line continuity");
});

test("keeps numbered activities as independent retrieval boundaries", () => {
  const content = `# Activities\n1. Echo and move\nStudents sing and move to a melody.\n\n2. Play and reflect\nStudents play classroom instruments.`;
  const chunks = splitKnowledgeDocument({ path: "resources/almeida/example.md", content, lines: content.split("\n") });

  assert.equal(chunks.length, 2);
  assert.match(chunks[0].label, /1\. Echo and move/);
  assert.match(chunks[1].label, /2\. Play and reflect/);
});

test("expands common music-language requests and ranks required source passes", () => {
  const index = createKnowledgeIndexForTests({
    "curriculum/grade-3.md": `---\ngrade: "Grade 3"\n---\n# Q1 sequence\nUnit Q1 Unit 2: Musical Form\nMU.3.O.1.1: Identify musical elements.\nStudents identify AB form and returning sections through singing.`,
    "resources/gameplan/grade-3.md": `---\ngrade: "Grade 3"\n---\n# Grade Three\nActivity: Form game\nStudents move when the AB form returns.`,
    "resources/almeida/cfoc.md": `# Little Bird\nFocus: AB Form, Timbre.\nSongs: "Little Bird". Students move and play percussion.`,
  });
  const result = searchKnowledgeInIndex(index, { query: "when the same musical idea returns", gradeLevel: "Grade 3", limit: 6 });

  assert.ok(result.expanded_concepts.includes("form"));
  assert.deepEqual(result.results.slice(0, 3).map((item) => item.retrieval_pass), ["district_curriculum", "grade_specific_gameplan", "approved_supplemental"]);
  assert.ok(result.results.some((item) => item.concepts.includes("form")));
});

test("broadens automatically when the curriculum pass is empty and exposes metadata", () => {
  const index = createKnowledgeIndexForTests({
    "curriculum/grade-3.md": `---\ngrade: "Grade 3"\n---\n# Rhythm\nUnit Q1 Unit 1: Rhythm\nMU.3.S.2.1: Identify patterns.\nStudents perform rhythm patterns.`,
    "resources/gameplan/grade-3.md": `---\ngrade: "Grade 3"\npriority: 90\n---\n# Grade Three\nUnit Q2 Unit 4: Melodic ideas\nMU.3.O.1.1: Identify musical elements.\nSongs: "Alabama Gal".\nFocus: Melody. Students sing, move, and read notation.`,
  });
  const result = searchKnowledgeInIndex(index, { query: "melody", gradeLevel: "Grade 3" });
  const gamePlanResult = result.results.find((item) => item.path === "resources/gameplan/grade-3.md");

  assert.equal(result.search_strategy.broadened_after_empty_first_pass, true);
  assert.equal(gamePlanResult?.source_group, "GamePlan");
  assert.equal(gamePlanResult?.source_priority, 90);
  assert.equal(gamePlanResult?.grade, "Grade 3");
  assert.equal(gamePlanResult?.quarter, "Q2");
  assert.match(gamePlanResult?.unit || "", /Unit 4/);
  assert.deepEqual(gamePlanResult?.standards, ["MU.3.O.1.1"]);
  assert.ok(gamePlanResult?.concepts.includes("melody"));
  assert.ok(gamePlanResult?.activity_types.includes("singing"));
  assert.deepEqual(gamePlanResult?.repertoire, ["Alabama Gal"]);
});
