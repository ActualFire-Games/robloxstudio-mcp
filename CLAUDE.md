# CLAUDE.md

This repository hosts the **robloxstudio-mcp** server (ActualFire-Games fork of the Chrrxs lineage),
which Claude uses to read and edit a **live Roblox Studio session** over MCP. Server/plugin changes are
made **here**: rebuild with `npm run build:all` (the Studio plugin auto-installs to the local Plugins
folder; restart the MCP server and Studio to pick up changes), run tests with `npm test`.

The actual game code lives **inside the connected Roblox Studio place** — reached through the
`Roblox Studio` MCP tools (`get_script_source`, `edit_script_lines`, `grep_scripts`, `get_descendants`,
`execute_luau`, …), **not** in this repo's files. When editing that game code (Roblox **Luau**), follow
the conventions below.

## MCP server capabilities (current truths)

- **73 tools.** With one Studio window connected, routing is automatic. With several, pass
  `instance_id` per call **or** pin once with `set_active_session` (discover via `list_studio_sessions`);
  an explicit `instance_id` always overrides the pin.
- **Playtests ARE drivable**: `solo_playtest` (start/stop/status, mode play/run) and
  `multiplayer_playtest`. Runtime peers register as roles `server` / `client-N`.
- **Two execution paths**: `execute_luau` runs in a fresh plugin-context sandbox (targets edit, server,
  client-N); `eval_server_runtime` / `eval_client_runtime` run **inside the live game-script VM sharing
  the game's require cache** — use these to inspect or poke live singleton/module state during a playtest.
  Client VMs are reached through an automatic server-side RemoteFunction broker; no setup needed.
- **Diagnostics during playtests**: `get_runtime_logs` (per-peer ring buffers), `capture_script_profiler`
  (per-function Luau CPU via ScriptProfilerService), `capture_micro_profiler` (engine-wide LibMP timers —
  aggregation is time-budgeted so captures do not freeze gameplay; the first capture per session absorbs
  a ~24-frame warmup; `action:"arm"` + `action:"collect"` do trigger-based spike captures via a
  `frame_time` / `attribute` / `log` trigger, `frame_breakdown` gives per-frame top timers for the longest
  frames and the trigger frame, `action:"analyze"` re-slices a stored snapshot without re-capturing
  (last 3 captures / 10 minutes), and `include_sections` adds the optional tables back inline),
  `get_memory_breakdown` (per-tag), `get_scene_analysis` (SceneAnalysisService;
  requires the Scene Analysis beta feature), `capture_screenshot` (works during playtests),
  `simulate_mouse_input` / `simulate_keyboard_input`, `breakpoints`, and network/device simulation tools.
- **`get_runtime_logs` cursors are per buffer.** Every buffer (`edit`, `server`, `client-N`) has its
  own `seq` counter and the edit buffer is never cleared, so a numeric `since` is only valid for the
  single buffer whose `nextSince` produced it. For `target:"all"` pass the returned `nextSince` map
  back as `since`, or pass `since:"playtest"` to read only what the current playtest has logged
  (runtime buffers in full, edit buffer trimmed to the playtest start). Buffers are per DataModel, so
  old edit-mode output (compile checks, `execute_luau` prints) only shows up when the edit buffer is
  read without a cursor.
- **`get_class_info`** resolves from the version-matched official Roblox API dump: complete
  properties/methods/events with types, security tags, and inheritance (falls back to live probing
  offline).
- Asset/marketplace tools (`search_assets`, `get_asset_details`, …) need `ROBLOX_OPEN_CLOUD_API_KEY`
  or `ROBLOSECURITY` env vars; without them they return a clear env error.
- **Tool guide resource.** `robloxstudio://tool-guides` holds the workflows, limits, and safety
  notes that no longer fit in the short tool descriptions. It is large, so prefer one section:
  `robloxstudio://tool-guides/{section}` (heading lowercased, spaces as hyphens), e.g.
  `robloxstudio://tool-guides/debugging-and-profiling`. Sections are listed in `resources/list`.
- **Multiple Claude sessions are safe**: the first server process is primary on port 58741; later ones
  run as transparent proxies forwarding to it.

## Removed/renamed tools (older docs and habits may reference these — do not use)

- `get_script_analysis` → **removed**. Compile-check a script via `execute_luau`:
  `local fn, err = loadstring(sourceText) print(err or "compiles OK")` — catches syntax errors with line
  numbers. It does **not** type-check and does not run the game.
- `start_playtest` / `stop_playtest` / `get_playtest_output` → `solo_playtest` + `get_runtime_logs`.
- `get_output_log` → `get_runtime_logs`.
- `analyze_scene` → `get_scene_analysis`.
- `capture_profile` / `get_profile_summary` / `export_profile_dump` → `capture_micro_profiler`
  (`output_path` / `summary_output_path` cover snapshot export; baselines via `baseline_path`).
- `get_selection` → `selection` with `action:"get"`. The same tool also does `action:"set"`
  (with `mode:"set"|"add"|"remove"`) and `action:"view"` to aim the edit-mode camera at an
  instance before `capture_screenshot`.
- `undo` / `redo` → **removed**. Drive `ChangeHistoryService` through `execute_luau` when a
  workflow genuinely needs history control; ordinary edits already record undo waypoints the
  user can reverse with Ctrl+Z.
- `create_build` / `generate_build` / `get_build` / `import_build` / `export_build` /
  `list_library` / `import_scene` / `search_materials` → **removed**. Build scenes with
  `execute_luau` instead, and query `MaterialService` the same way.

## Luau conventions for the live game code

- **Block comments on functions.** Put a `--[[ ]]` block comment above every function describing what it does
  and any non-obvious assumptions.
- **No em dashes in comments.** Use commas, colons, parentheses, or separate sentences instead; a `--`
  standing in for a dash is just as unwelcome inside Lua comments.
- **Plain-language comments.** Write comments for a learning scripter: prefer everyday wording over fancy
  vocabulary ("deliberately mismatched speeds", not "mutually non-harmonic rates"). Technical terms are
  still welcome where plain words would lose the meaning (orthonormal, basis vector, unit vector).
- **Generic modules get generic comments.** In shared/utility modules (Trove, Signal, FunctionUtils, and
  the like), a comment may explain what a change does and the general mechanism it addresses ("leaves the
  thread alive as an untracked orphan"), but never tie it to the specific game system or incident that
  prompted it ("duplicated station work loops"). Situation-specific context belongs in that system's own
  code or the commit message, not in a reusable module.
- **Dependency injection for generic package modules.** A generic/agnostic module — especially anything
  package-managed under `ModulesUniversal` — must never `require` game-specific modules or hard-code game
  tags, names, or instances. Expose registration/injection APIs on the generic module instead, and let a
  small game-side setup module inject the game's tags, callbacks, or config at load (see
  `StylizedWaterService:RegisterSplashTag` fed by `StarterPlayerScripts.Setup._WaterSplashTagSetup` for the
  pattern). Design injection APIs to be call-order independent (late registration wires up live) so loader
  ordering never matters.
- **No cyclic module dependencies, ever.** A "Cyclic module dependency" warning in Script Analysis is a
  sign of bad structure, not a warning to silence: when two modules need each other, a responsibility
  lives in the wrong place, so re-evaluate the structure instead of working around it. Moving a `require`
  inside a function (a "lazy require") is **not** a fix: it only hides the cycle from the runtime, the
  analyzer still reports it, and the coupling is still there. Break a cycle with one of these, in order of
  preference: move the function to the module that owns the data it touches; have the lower-level module
  expose a registration/injection API that the higher-level module (or a small setup module) feeds at load;
  fire a signal from the lower module that the higher module listens to; or extract the shared piece into a
  small mediator/interface module that both sides depend on. Dependencies flow one way only (shared
  data/types, then utilities, then domain systems, then orchestrators/UI); a lower layer never requires a
  higher one. A child module never requires its parent/ancestor module: pass what the child needs into its
  constructor. Before adding a `require`, check that the target does not already depend, directly or
  transitively, on the requiring module.
- **`const` and require-by-string are valid Luau.** Both were recently added to the language and run natively —
  including in Studio edit mode. Never treat `const x = ...` or `require("@game/ServerScriptService/...")` as a
  pre-build dialect needing a transform step, and never "fix" them back to `local` / instance requires.
- **Require-by-string path semantics.** Relative paths resolve against the requiring script's **parent**:
  `./X` is a **sibling**, `../X` is in parent.parent. To require a **child** of the requiring script, use
  `@self/X`. Three aliases exist at this time: `@self` (the requiring script itself), `@game` (DataModel
  root, e.g. `@game/ServerScriptService/...`), and `@rbx`.
- **`const` for immutable bindings.** This codebase uses `const` for everything that is never reassigned —
  services, `require`s, **and constants**. Use plain `local` only for genuinely mutable variables.
- **No magic values.** Lift literals into named `LOUD_SNAKE_CASE` (`UPPER_SNAKE_CASE`) `const` constants where
  it aids clarity, instead of inlining them.
- **Expanded guard clauses.** Write guards multi-line with an early `return`/`continue`. Never collapse them to
  one line (no `if x then return end`).
- **Guard clauses over nesting.** Prefer early returns to flatten control flow; avoid deeply nested conditionals.
- **Scope throwaway setup in a `do` block.** When producing a value takes several steps the rest of the scope
  doesn't need, wrap them in a `do` block so only the result escapes — expanded, never one line:

  ```lua
  local x do
      -- steps that compute x, scoped away from the rest
      x = ...
  end
  ```

  If that derivation needs early-return guards, prefer a small dedicated function instead — a `do` block can't
  early-return, and forcing it into nested `if`s would violate the guard-clause rule above.
- **Sparing HTML in doc comments.** Use tags like `<code>`, `<b>`/`<strong>` where they genuinely aid
  readability, but don't overdo it.
- **Generic, agnostic, loosely-coupled (SOLID).** Favor designs that discover by selector/name and derive from
  geometry/state rather than hard-coding instances, magic axes, or magic signs. Keep responsibilities separated
  so pieces aren't tightly coupled.
- **Guard require-time setup with `RunService:IsRunning()`.** If a module creates instances as a side
  effect of being required (folders, sounds, object caches/pools, etc.), gate that setup behind
  `RunService:IsRunning()` — modules also get required from the command bar / plugin context in edit-mode
  Studio, and unguarded setup litters the edit DataModel with unwanted instances (see `FunctionUtils._sound`'s
  `loadedFolder` for the pattern). Use best judgment: setup that creates no instances doesn't need the gate.
- **Weak tables and Roblox Instances don't mix.** References to Instances are never weak — a `__mode` table
  with Instance keys/values never gets those entries collected, so Instance-keyed caches need explicit
  eviction tied to the instance's lifetime (`Destroying`/ancestry hooks or the owning system's teardown path).
  Weak tables work as expected for plain tables, including OOP-style objects (tables mimicking objects).

## Verifying game edits

After editing a script, **compile-check it** via the `execute_luau` loadstring check above. For runtime
behavior, playtest directly: `solo_playtest` start → `eval_server_runtime` / `get_runtime_logs` /
profilers → stop. Two caveats remain:

- **Edit-mode results can diverge from real play behavior.** Some bugs reproduce only in the play
  DataModel — notably runtime mesh/skinning (`CreateMeshPartAsync`, `EditableMesh`, skinned
  `MeshPart`/`Bone` deformation, `HasSkinnedMesh`) can render/deform fine in edit mode yet fail in play.
  Verify runtime-sensitive changes inside an actual playtest, not just edit-mode `execute_luau`.
- **`eval_*_runtime` return values are serialized inside the game VM** (JSON when encodable, `tostring`
  otherwise) before they cross the eval bridge, so `return require(SomeModule)` is safe even for
  self-referencing module tables. Prefer returning the specific fields you need over whole module tables.
- **Visual verification is the user's job.** Logs and eval results prove logic; whether something *looks*
  right needs the user's eyes — list exactly what they should check in a manual playtest.
- **Scripts inside Roblox Packages need the package marked as modified.** Studio does not reliably flag a
  package as modified when its scripts are edited through the MCP tools, and an unmarked package can be
  silently reverted by package auto-update or "Get Latest" (script edits survive place saves but not
  package updates). After editing any script with a `PackageLink`-holding ancestor (e.g.
  `ModulesUniversal.Systems.*.SystemPackage`), tell the user to verify the package shows the modified
  badge — a one-character edit-and-undo in the script editor forces it — before relying on the change.
  The script-editing tools return a `packageWarning` field when they touch a package-managed script.

## Subagent policy for Fable + Ultra code mode

When the session model is **Fable** and **Ultra code mode (ultracode) is on**:

- **Fable stays in the main loop** for orchestration, planning, and reviewing/judging results. Do not burn
  Fable subagents on legwork.
- **Delegate execution and exploration to Opus subagents.** When spawning subagents (Agent tool or
  Workflow `agent()` calls), set `model: 'opus'` and an effort of `'medium'` or `'high'` — pick per task
  (medium for routine/mechanical work, high for harder implementation or verification stages).
- This applies to both fan-out searches/exploration and implementation stages; synthesis, adversarial
  review, and final judgment remain with Fable in the main conversation.

## Deferred signaling semantics (the game runs SignalBehavior = Deferred)

- When a signal fires, its handlers resume **at the end of the CURRENT resumption cycle** — NOT on the next
  frame. Every frame has multiple resumption points (`RunService.PreRender`, `RunService.Heartbeat`, etc.).
  Firing a BindableEvent from code running in PreRender resumes its listeners at the deferred point (end of
  the queue) **within PreRender**, not next frame.
- `task.defer` behaves the same way: deferring from Heartbeat code queues the function at the end of the
  deferred-tasks queue for the **current Heartbeat resumption cycle**.
- Profiling consequence: a bulk replication batch arriving via `ProcessPackets` drains **all** its per-item
  deferred handlers (ChildAdded/ChildRemoved/tag/attribute signals) inside that same frame's
  `deferredThreads` sections — deferral coalesces within a cycle but does **not** spread work across frames.
  Amortizing work across frames requires an explicit queue drained under a per-frame budget, not `task.defer`.

## Code Comments
- Default to no comment. Code shows *how*; comment only to carry *why* — a non-obvious constraint, deliberate deviation, gotcha, or workaround.
- Never narrate the code ("loop over users", "parse the body"), restate names/types/signatures, or mark block ends.
- Never narrate the change ("fixed X", "updated to Y", "as requested"). A comment must read correctly to someone seeing the file fresh who never saw the diff; change context belongs in the commit message.
- Delete by default. A comment that just restates a decision the code already reflects — "1 vCPU is deliberate", "right-sized from prod" — is dead weight even when it points to a doc: the doc is where anyone questioning it looks anyway. Keep inline only what a reader needs *at that line* and can't get from the code — a non-obvious invariant/constraint ("timeout must stay < interval — ALB rule") or a cross-file sync obligation ("keep in sync with the router's TGs").
- Comments must stand on their own with any link removed — encode the substance, never a pointer as a substitute for it. Banned: specs, section numbers, design docs — point-in-time artifacts that get superseded and rot ("spec §7" is the canonical case). Fine: a maintained doc/README at a stable path — and when the *why* is a system-level narrative ("why it's built this way"), extract it there as a *pure* extraction: not an inline block, and not a comment that merely points to the doc. What stays inline are the non-obvious local details, which reference the doc only when a reader genuinely needs it *at that line* — a pointer-only comment generally shouldn't exist at all. Tickets, Confluence, RFCs, permalinks stay fine as trailing breadcrumbs.
- Occam's razor on every comment you *keep*, not just the ones you delete. "Carries a real *why*" and "is worded minimally" are independent judgments — a genuine *why* can still be 3x too long, and "it's a real why" is not license to keep the wording verbatim. Keep only the one non-obvious fact a reader needs *at that line*, in the fewest words; cut the mechanism the code already shows, where a value is consumed downstream, the consequence-of-the-consequence, and justification-of-the-justification. A 5-line block almost never survives intact — suspect it on sight; the razored answer is sometimes zero.
- A one-line summary on a public function/endpoint is fine; inline restatement of a single clear line never is.
- TODOs are fine and don't need issue IDs — but a TODO is a marker, not a substitute for doing the work in scope.