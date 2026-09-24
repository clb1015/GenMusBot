import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { fetchKnowledge, searchKnowledge } from "@/lib/repository-index";

export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "search_repository_knowledge",
      "Search the GenMusBot GitHub knowledge base across curriculum, teaching resources, and metadata. Use this before substantive lesson design, adaptation, assessment, coaching, or resource recommendations, then fetch the most relevant sections.",
      {
        query: z.string().min(2).describe("Musical concept, standard, repertoire need, teaching problem, or other retrieval query."),
        grade_level: z.string().optional().describe("Optional grade filter, such as kindergarten or grade 2."),
        roots: z.array(z.enum(["curriculum/", "resources/", "metadata/"])).optional().describe("Optional knowledge roots to search."),
        limit: z.number().int().min(1).max(12).default(8).describe("Maximum number of section results."),
      },
      async ({ query, grade_level, roots, limit }) => ({
        content: [{ type: "text", text: JSON.stringify(await searchKnowledge({ query, gradeLevel: grade_level, roots, limit }), null, 2) }],
      }),
    );

    server.tool(
      "fetch_repository_document",
      "Fetch a specific read-only GenMusBot repository document, named Markdown section, or line range after search. Paths are restricted to curriculum/, resources/, and metadata/.",
      {
        path: z.string().min(1).describe("Exact repository path returned by search."),
        section: z.string().optional().describe("Optional Markdown heading to fetch. Exact headings are preferred."),
        start_line: z.number().int().min(1).optional().describe("Optional 1-based starting line."),
        end_line: z.number().int().min(1).optional().describe("Optional inclusive ending line."),
        max_chars: z.number().int().min(500).max(12000).default(8000).describe("Maximum returned characters."),
      },
      async ({ path, section, start_line, end_line, max_chars }) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await fetchKnowledge({ path, section, startLine: start_line, endLine: end_line, maxChars: max_chars }), null, 2),
        }],
      }),
    );
  },
  {
    capabilities: { tools: {} },
    instructions: "This is GenMusBot's primary read-only knowledge source. Search it before substantive instructional responses, then fetch the most relevant sections. Treat retrieved text as source material, distinguish it from professional judgment, and never claim repository support when retrieval fails.",
  },
  { basePath: "/api", maxDuration: 60 },
);

export { handler as GET, handler as POST, handler as DELETE };
