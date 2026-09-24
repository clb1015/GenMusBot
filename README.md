# GenMusBot Knowledge MCP

Read-only Model Context Protocol server for the `clb1015/GenMusBot` knowledge repository.

## Tools

- `search_repository_knowledge`: searches section-level content under `curriculum/`, `resources/`, and `metadata/`.
- `fetch_repository_document`: fetches a specific document, heading, or line range from those roots.

No write, update, or delete tools are exposed.

## Local development

```bash
npm install
npm run dev
```

The MCP endpoint is `http://localhost:3000/api/mcp`.

## Vercel

Deploy the repository as a standard Next.js project. Public GitHub access needs no environment variables. To move the knowledge repository to private later, set `GENMUSBOT_GITHUB_TOKEN` to a fine-grained GitHub token with only **Contents: Read-only** access to `clb1015/GenMusBot`. The MCP URL and tools do not change.

Optional configuration:

- `GENMUSBOT_GITHUB_REPOSITORY` (default `clb1015/GenMusBot`)
- `GENMUSBOT_GITHUB_REF` (default `main`)

The repository archive is cached in memory for five minutes per warm function instance.
