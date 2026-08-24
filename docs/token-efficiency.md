# Token-efficiency contract

Version 3.0 treats the MCP wire surface as a budgeted public API.

## Catalog budget

Upstream caps the serialized public catalog at 43,000 characters, tool
descriptions at 120 characters, and argument descriptions at 64 characters.

**This fork has not adopted those two description budgets yet.** It keeps the
larger tool surface upstream 3.0 removed, and its descriptions still carry
operational detail, so the regression test currently caps the catalog at 125,000
characters and does not enforce per-description limits. Every argument still
requires a description, and structured output schemas are still required for
every tool except the Markdown-returning `get_roblox_docs`.

Adopting the description budgets (and moving the stripped detail into the
`robloxstudio://tool-guides` resource) is the main remaining token win here:
roughly 11,000 tokens, versus about 7,600 for dropping the extra tools. Change
the budget only as an explicit API decision.

## Advertisement contract

- A tool description is one sentence that explains when or why to call it.
- Every input property describes its meaning and any constraint not already
  encoded by `enum`, `required`, bounds, or another JSON Schema keyword.
- Tool annotations contain only `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` behavior metadata.
- Server instructions hold shared constraints and cross-tool sequences. They are
  generated from the tools exposed by each server edition, so they never name an
  unavailable tool.
- Detailed workflows and safety notes are available on demand at
  `robloxstudio://tool-guides`. Official engine references remain available through
  the `robloxdocs://` resource templates.

The server advertises shared instructions once. Clients read the detailed tool
guide only when needed, and the guide is not part of the tool catalog.

## Response contract

- Modern 2026-07-28 clients receive JSON once, in `structuredContent`.
- Legacy 2025 clients receive one JSON text projection for compatibility.
- Human-readable Markdown and image/audio content remain content blocks.
- Known bundle, plugin-session, version-mismatch, debug, and diagnostic metadata
  fields are removed at the protocol boundary.
- `get_connected_instances` returns each place once as `{ id, name, roles }`
  instead of repeating full plugin diagnostics for every edit/server/client peer.
- Tool errors expose a short stable code, an actionable message, and only the
  recovery data a caller needs. Full diagnostics go to stderr.

The shared boundary in `packages/core/src/mcp-runtime.ts` owns catalog projection,
annotations, input/output schemas, result normalization, and public error shaping
for both HTTP and stdio transports.
