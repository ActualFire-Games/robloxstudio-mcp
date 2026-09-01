# Token-efficiency contract

Version 3.0 treats the MCP wire surface as a budgeted public API.

## Catalog budget

Upstream caps the serialized public catalog at 43,000 characters, tool
descriptions at 120 characters, and argument descriptions at 64 characters.

This fork enforces the same two description budgets. It keeps a larger tool
surface than upstream 3.0, so the catalog ceiling is higher: the regression test
caps the serialized public catalog at 72,000 characters. Every argument still
requires a description, and structured output schemas are required for every tool
except the Markdown-returning `get_roblox_docs`.

### Where the budget is actually enforced

`publicToolDefinition` in `packages/core/src/mcp-runtime.ts` passes every
description through `concise()` before it reaches a client, clipping tool
descriptions to 120 characters and argument descriptions to 64. That projection
is what a client sees, so the wire format is inside budget whatever the source
says.

This matters when estimating savings. Measuring `definitions.ts` overstates the
catalog badly, because the source text is truncated before it is advertised.
Measure `TOOL_DEFINITIONS.map(publicToolDefinition)` instead.

The reason to write descriptions that already fit is therefore correctness, not
size. When source text overflows, `concise()` keeps only the first sentence and
then clips mid-phrase with an ellipsis, so the client reads a fragment. Before
this fork adopted the budget, 13 of 84 tool descriptions and 250 of 422 argument
descriptions reached clients truncated that way, including the `instance_id`
description repeated across most tools, whose clipped form lost the clause
explaining when the argument is required.

### Measured effect of adopting the budget

| | tools | advertised catalog |
| --- | --- | --- |
| before | 84 | 75,019 chars (~20,275 tokens) |
| after removing 11 tools | 73 | 66,592 chars (~17,998 tokens) |
| after also rewriting descriptions | 73 | 68,136 chars (~18,415 tokens) |

Removing tools is what saves tokens, about 2,300. Rewriting descriptions costs
roughly 400 tokens back, because purpose-written text is often longer than the
truncated fragment it replaces. Its payoff is that no description reaches a
client truncated any more. Change the budget only as an explicit API decision.

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
  `robloxstudio://tool-guides`. Because that guide is large, every heading is also
  addressable on its own at `robloxstudio://tool-guides/{section}`, where the slug
  is the heading lowercased with spaces as hyphens. Sections are enumerated in
  `resources/list` and the slug supports completion, so a client that needs one
  topic reads a few KB instead of the whole document. Official engine references
  remain available through the `robloxdocs://` resource templates.

The server advertises shared instructions once. Clients read the detailed tool
guide only when needed, and the guide is not part of the tool catalog.

## Response contract

- Modern 2026-07-28 clients receive JSON once, in `structuredContent`.
- Legacy 2025 clients receive one JSON text projection for compatibility.
- Human-readable Markdown and image/audio content remain content blocks.
- Tools that answer with media (`capture_screenshot`, `get_asset_thumbnail`,
  `capture_device_matrix`) put their metadata in the structured object and keep
  the image as a content block. A schema'd result with no JSON object at all
  still gets a synthesized structured object (`{ message }` from its text, or
  `{}`), because every tool but `get_roblox_docs` advertises an output schema
  and the SDK rejects a schema'd result without structured content.
- Known bundle, plugin-session, version-mismatch, debug, and diagnostic metadata
  fields are removed at the protocol boundary.
- `get_connected_instances` returns each place once as `{ id, name, roles }`
  instead of repeating full plugin diagnostics for every edit/server/client peer.
- Tool errors expose a short stable code, an actionable message, and only the
  recovery data a caller needs. Full diagnostics go to stderr.

The shared boundary in `packages/core/src/mcp-runtime.ts` owns catalog projection,
annotations, input/output schemas, result normalization, and public error shaping
for both HTTP and stdio transports.
