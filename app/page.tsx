export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 760, margin: "64px auto", padding: 24 }}>
      <h1>GenMusBot Knowledge MCP</h1>
      <p>Read-only curriculum retrieval for GenMusBot.</p>
      <ul>
        <li>MCP endpoint: <code>/api/mcp</code></li>
        <li>Knowledge source: <code>clb1015/GenMusBot</code></li>
        <li>Allowed roots: <code>curriculum/</code>, <code>resources/</code>, <code>metadata/</code></li>
      </ul>
    </main>
  );
}
