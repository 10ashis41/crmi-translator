## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## 🧠 3-Tier Memory Routing Rules
- Codebase Structure & AST (Graphify): Use `graphify query` when asked about imports, function definitions, or code architecture.
- Session History & Command Logs (claude-mem): Use `mem-search` to recall past chat sessions, terminal commands, or prior debugging logs from previous conversations.
- Declarative Facts & State (MCP Memory Keeper): Use `mcp_context_get` and `mcp_context_save` to store and retrieve explicit project rules, current task milestones, and architectural decisions. Do not store secrets, API keys, or credentials here.

## Operating Guardrails
- Do not overwrite or delete existing settings in `.claude/settings.json`; safely append configurations so Graphify hooks remain active.
- Before completing long multi-step tasks, save key state milestones using `mcp_context_save`.
