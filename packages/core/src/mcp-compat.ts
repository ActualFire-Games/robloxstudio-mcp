import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { DOC_CATEGORIES, fetchRobloxDoc, isDocCategory, DocNotFoundError } from './roblox-docs.js';

export const TOOL_GUIDE_URI = 'robloxstudio://tool-guides';
export const TOOL_GUIDE_SECTION_URI_PREFIX = 'robloxstudio://tool-guides/';

export interface ToolGuideSection {
  /** Stable URI slug derived from the heading, for example "debugging-and-profiling". */
  slug: string;
  /** The heading text as it appears in the guide. */
  title: string;
  /** Self-contained markdown: the guide preamble, this heading, and its body. */
  markdown: string;
}

/** Derive a stable URI slug from a "## " heading. */
function toolGuideSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Split the guide on its "## " headings so a client can read one section instead of the whole
 * document. The guide is large enough that fetching all of it to answer one question wastes
 * most of what it costs. The preamble above the first heading is repeated into every section
 * so each one still explains what it is when read on its own.
 */
function parseToolGuideSections(markdown: string): ToolGuideSection[] {
  const lines = markdown.split('\n');
  const firstHeading = lines.findIndex((line) => line.startsWith('## '));
  if (firstHeading < 0) return [];
  const preamble = lines.slice(0, firstHeading).join('\n').trimEnd();

  const sections: ToolGuideSection[] = [];
  let title: string | undefined;
  let body: string[] = [];

  const flush = () => {
    if (title === undefined) return;
    sections.push({
      slug: toolGuideSlug(title),
      title,
      markdown: `${preamble}\n\n## ${title}\n${body.join('\n').trimEnd()}\n`,
    });
  };

  for (const line of lines.slice(firstHeading)) {
    if (line.startsWith('## ')) {
      flush();
      title = line.slice(3).trim();
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

export const TOOL_GUIDE_MARKDOWN = `# Roblox Studio MCP tool guide

Tool descriptions explain selection. Input schemas explain arguments. This guide holds the shared workflows, value encodings, defaults, limits, and safety notes that do not fit in a short description. When a tool behaves in a way its description does not explain, the answer is here.

Every heading below is also readable on its own at robloxstudio://tool-guides/{section}, where {section} is the heading lowercased with spaces as hyphens, for example robloxstudio://tool-guides/debugging-and-profiling. Prefer one section over this whole document when you already know the topic.

## Connection and paths

- Canonical paths are dot syntax from game, for example game.ServerScriptService.Main. Segments whose names contain dots or other special characters must be bracketed and quoted: game.ServerScriptService[".dir"].Main. Every discovery tool returns paths in this form, ready to paste into the edit tools.
- Every tool accepts instance_id. Omit it when exactly one Studio place is connected. Otherwise pass an id from get_connected_instances or list_studio_sessions, or pin one once with set_active_session. An explicit instance_id on a call always overrides the pin.
- When several sessions are connected and none is pinned, any call that omits instance_id fails with multiple_instances_connected. Fix it by pinning a session or by passing instance_id on every call.
- get_connected_instances lists connected plugin instances with their role (edit, server, client-N) and instance ID. Use it during a multi-client playtest to find the IDs and peer names you pass as instance_id or target. It lists plugin instances, not places.
- list_studio_sessions lists the open places instead: each entry shows the place name and place ID plus its connected instances (edit, and playtest server and client-N), and flags which session is currently pinned as the routing target.
- set_active_session pinned by placeId or placeName scopes the whole session, including that place's playtest server and client-N instances. placeName matching is case-insensitive and must resolve to exactly one connected session, otherwise the call is rejected. Pin by instanceId only when the same place is open in two windows and you need one specific window. Pass clear=true to unpin and return to default routing; the pin also auto-clears once the pinned session fully disconnects.
- get_place_info returns placeName (looked up through MarketplaceService when PlaceId is above 0, otherwise the DataModel name), dataModelName, placeId, gameId, jobId, and the Workspace name and className. It does not return game settings such as gravity or lighting: read those with get_instance_properties on the relevant service.
- placeId and gameId are 0 for an unpublished place, and jobId is empty outside a running session. Use get_place_info to confirm you are talking to the place you think you are before any destructive edit.

## Discovery and edit work

- get_project_structure is the default hierarchy tool. With no path (or path=game) it returns a service_overview listing Workspace, ServerScriptService, ServerStorage, ReplicatedStorage, StarterGui, StarterPack, StarterPlayer, and Players with child counts, not a tree. Pass a concrete path such as game.ServerScriptService to expand one branch.
- get_project_structure output is deliberately incomplete when a node has more than 20 children and depth is still below maxDepth: it emits a childSummary grouped by class, at most 3 real children per class, and a "... N more <Class> objects" node whose className is MoreIndicator. Never treat that as the full child list; re-run against the deeper path or use get_descendants when you need every child.
- Nodes at maxDepth come back with hasMore=true and only a childCount. Raise maxDepth or re-run starting from that node's path. Depth is counted from the start path, not from game.
- get_project_structure scriptsOnly keeps BaseScripts, ModuleScripts, and Folders. Folders are retained on purpose so nesting paths stay navigable, so expect empty folders in the result. Nodes are annotated by kind: scripts get hasSource, scriptType, and enabled; GuiObjects get visible, a guiType of container, text, or image, and text for non-empty labels and buttons. The echoed requestedPath, maxDepth, and scriptsOnly confirm what was actually traversed.
- get_file_tree walks a whole subtree with no result cap and stops descending at depth 10. Deeper nodes come back as a bare name and className with an empty children list, which looks identical to a real leaf. Run on game or Workspace it can be enormous, so prefer get_project_structure with a maxDepth, or aim get_file_tree at a narrow path. Its nodes carry name, className, path, and for scripts hasSource, scriptType, and (for BaseScripts) enabled, which is enough to pick targets for get_script_source without a second lookup.
- get_descendants returns every descendant with its depth in one round trip and is far cheaper than repeated per-level calls. classFilter is matched with IsA, so BasePart also matches Part, MeshPart, WedgePart, and other subclasses; name an exact leaf class only when you truly want just that class. maxDepth defaults to 10: raise it for deep rigs or UI trees, lower it to keep a large Workspace scan from flooding context.
- search_files scans the entire DataModel from game on every call and returns every match with no cap, so narrow the query before running it on a large place. searchType type matches ClassName (search_objects spells the same mode class), and name and type are substring matches, not exact matches. Results include path, className, hasSource, and enabled for BaseScripts, plus a count; a zero count means no match, not a failed call.
- search_files with searchType content reads every script's source and reports only which scripts matched, with no line numbers and no surrounding context. Use grep_scripts when you need matching lines or context, and find_and_replace_in_scripts to act on them.
- search_objects also scans the whole DataModel per call, uncapped, matching case-insensitive substrings. It returns only name, className, and path per hit, so follow up with get_instance_properties, get_attributes, or get_script_source on the paths it returns. Prefer get_tagged when the instances you want are CollectionService-tagged.
- With search_objects searchType property you must also pass propertyName; forgetting it makes the search match nothing at all rather than erroring. In property mode the value is stringified before matching, so a query of Neon matches Enum.Material.Neon and true matches booleans.
- Pattern escaping, shared by search_files, search_objects, search_by_property, grep_scripts, and find_and_replace_in_scripts: queries are lowercased and handed to Lua string.find as patterns, so - . ( ) [ ] % + * ? ^ and $ act as pattern magic. Escape them with a percent sign (%- and %.) or a literal-looking query will silently miss or error. Lua patterns are not PCRE: use the %d, %a, and %w classes and ".-" rather than ".*?".
- compare_instances diffs properties only. It does not compare children, descendants, attributes, or tags, so pair it with get_descendants, get_attributes, or get_tags when a structural or metadata difference is suspected. Both arguments are canonical DataModel paths; its classic use is explaining why a duplicate behaves differently from its original.
- get_services and get_instance_children are legacy endpoints that the current Studio plugin build does not route. If either returns an "Unknown endpoint" error, use get_project_structure with no path for the service overview, and get_descendants or get_project_structure with maxDepth=1 for one level of children.
- Use execute_luau for custom traversal, bulk edits, procedural scene construction, and any work that would otherwise need many tool calls. There are no build, scene-import, asset-library, or material-search tools: script the build with execute_luau, or assemble it with create_object and mass_create_objects.
- There is no undo or redo tool either. Ordinary edits are already recorded as Studio undo waypoints the user can reverse with Ctrl+Z; when a scripted undo or redo is genuinely needed, drive ChangeHistoryService through execute_luau.
- Confirm a member's exact name, type, and security tag with get_class_info before a write. Property writes run in the plugin sandbox, so RobloxScriptSecurity members can never be set, and a misspelled name either errors or is swallowed depending on the write path.

## Properties

- get_instance_properties returns a curated fixed set, not the class's full property list: Name, ClassName, Parent, common BasePart, GUI, Sound, Mesh, Decal and Texture, and clothing properties, plus ChildCount. A property missing from the response may still exist on the instance. Use get_class_info for the real API surface, and mass_get_property or execute_luau to read anything not covered.
- Its values come back stringified ("true", "Enum.Material.Neon", "0, 0, 0"), Parent is returned as a canonical path, and UDim2 is the single structured exception ({X:{Scale,Offset}, Y:{Scale,Offset}, _type:"UDim2"}). Parse accordingly rather than assuming native types.
- For scripts the full Source is included by default, which is expensive on large modules. Pass excludeSource=true to get SourceLength (characters) and LineCount instead, or use get_script_source when you want the text with line numbers for a later edit_script_lines call.
- mass_get_property returns one serialized value per path (Vector3, Color3, EnumItem and friends come back as structured values, not Lua userdata) plus per-path success flags, so unreadable properties and missing instances show up individually instead of failing the call. For one property across many objects it is far cheaper than one get_instance_properties call per instance; use get_instance_properties only when you need the full property set of a single object.
- Value encoding for property writes (set_property, set_properties, mass_set_property, and the properties argument of create_object and mass_create_objects): a 3-element array becomes a Vector3, or a Color3 for Color and Color3 properties and for any property whose current value is already a Color3; a 2-element array becomes a Vector2; a 4-element array becomes a UDim2. Object forms work too: {X,Y,Z}, {R,G,B} (Color3 components are 0 to 1 floats, not 0 to 255), and {X:{Scale,Offset},Y:{Scale,Offset}} for a UDim2.
- Enum properties accept the bare item name as a string ("Neon" for Material, "Front" for a face). The strings "true" and "false" coerce to booleans. BrickColor accepts its numeric code. A JSON-encoded string of an array or object is decoded and converted like the real value, while a genuine string that merely looks like JSON is left alone.
- Writing Parent or PrimaryPart accepts a canonical path string and resolves it to that instance. An unresolvable path raises an error instead of silently clearing the reference, so reparenting is a normal property write.
- Every property write is wrapped in a ChangeHistoryService recording, so the user can undo it from Studio; a failed write is recorded as a no-op.
- set_properties applies each entry independently and in unspecified map order, so never rely on one property being set before another (Size before Position, anything before Parent, an Enum before the property it gates). Split order-sensitive writes into separate set_property calls. Failures are per property: the response lists each property with success or an error plus a succeeded and failed summary, and the remaining properties still apply, so check the summary before treating the instance as fully configured. The whole call is one undo recording.
- mass_set_property is partial-success by design: each path returns its own success or error entry (a path that resolves to nothing reports "Instance not found") plus a total, succeeded, and failed summary. Read the results array rather than assuming the whole batch landed. The same value is converted per instance, so a mixed-class batch where the property is a Vector3 on one class and a Vector2 on another fails only on the mismatched paths; it is never coerced across types. The whole batch lands inside one undo recording and is marked successful if at least one path succeeded.
- search_by_property walks every instance in the DataModel, reads propertyName under pcall, and does a case-insensitive substring match on the stringified value, so Anchored with true, Material with Neon, MeshId with rbxassetid://123, and ClassName with Part all work. Instances that lack the property are skipped silently instead of erroring.
- Because that match is a substring on text, Transparency with 1 also matches 0.15 and 0.1. Pick a longer, more distinctive value or post-filter the returned propertyValue field on each hit. The value is matched as a Lua pattern after lowercasing, so the escaping rule above applies (0%.5 is the safe way to pin an exact decimal).
- Both propertyName and propertyValue are required and non-empty; there is no wildcard listing mode. Once you have the paths, apply changes in bulk with mass_set_property rather than one set_property per hit.
- Setting a script's Source through a property write does work, but it bypasses the script tools' packageWarning. Prefer set_script_source or edit_script_lines so edits to package-managed scripts get flagged.

## Attributes and tags

- set_attribute rebuilds structured values from a _type tag on the value object. Supported tags: Vector2, Vector3, Color3, CFrame, UDim, UDim2, and BrickColor. Vector3, Vector2, and Color3 accept either named keys (X, Y, Z or R, G, B) or a positional array; UDim takes Scale and Offset; UDim2 takes X and Y objects each with Scale and Offset; CFrame takes a 12-number components array, or a Position object for a position-only CFrame; BrickColor takes Name.
- A structured value may also be sent as a JSON string. It is decoded only when it carries a known _type tag or when valueType names a structured type, otherwise it stays a plain string.
- Footgun: with no valueType, the strings "true" and "false" are coerced into real booleans. Pass valueType="string" to store the literal text. valueType="boolean" and valueType="number" likewise coerce stringified forms into real booleans and numbers.
- Roblox rejects attribute names that are empty, longer than 100 characters, contain anything but letters, digits, and underscores, or start with the reserved RBX prefix. Those come back as a SetAttribute failure, not a silent no-op.
- get_attributes returns attributes as a map of name to {value, type} where type is the Luau typeof name ("string", "number", "Vector3", ...) plus a count, so an empty map means the instance genuinely has no attributes. Structured values come back serialized with their _type tag, and that exact object can be fed straight back into set_attribute or bulk_set_attributes to copy an attribute between instances without hand-rebuilding the datatype.
- bulk_set_attributes writes several attributes to one instance in one round trip and one undo waypoint, which is why it is preferred over repeated set_attribute calls on the same instance. It targets a single instance only; for many instances, call it once per path.
- bulk_set_attributes has no valueType hint, so any non-primitive value must carry its own _type tag inside the object using the shapes set_attribute accepts; an untagged object will not become a datatype. The bare "true" and "false" coercion applies here too, and since there is no type hint, use set_attribute with valueType="string" when you need those stored as literal text.
- bulk_set_attributes applies attributes one at a time and fails per attribute: a bad name or unsupported value marks that entry failed while the rest still apply. Read the per-attribute results and the succeeded and failed summary instead of treating the call as all-or-nothing. Omitting a name leaves that attribute untouched; this tool never clears attributes.
- delete_attribute is SetAttribute(name, nil) and is idempotent: removing an attribute that was never there still reports success with existed=false, so check that field rather than assuming a successful call proves the attribute was present. There is no bulk delete, so loop per name (each call is its own undo waypoint) and confirm with get_attributes.
- get_tags returns tags (a plain string array from CollectionService:GetTags) plus a count. Reach for it before add_tag or remove_tag when tag-driven systems misbehave: a missing tag is the usual reason a CollectionService:GetInstanceAddedSignal handler never fires for an instance.
- Tag names are exact and case sensitive: Interactable and interactable are two different tags, and tagging with a typo silently does nothing useful because no listener is bound to it. Verify the spelling against the consuming code with grep_scripts first.
- add_tag adds one tag to one instance per call (no batch form, so loop over paths), each call its own undo waypoint. Adding a tag the instance already has is a no-op that still reports success with alreadyHad=true.
- remove_tag is likewise idempotent and case sensitive: removing a tag the instance never had still reports success with hadTag=false, so a successful call is not proof the tag was there or that you spelled it the way the game does. In a running session removal fires CollectionService:GetInstanceRemovedSignal for that tag, which can trigger teardown logic in game code, so expect the owning system to react immediately.
- get_tagged returns one entry per match with name, className, and the canonical path you can feed directly into the property, attribute, or tag tools, plus a count. Lookup is exact and case sensitive with no wildcards or partial matching, so an empty result usually means a spelling mismatch with the tag the game code registers.
- get_tagged walks the whole place, so a very common tag can return a large list; narrow by working from the returned paths rather than re-querying.
- Tags and attributes are read from the DataModel of the targeted session only. Instances tagged at runtime by game code exist only in the play DataModel, so during a playtest query CollectionService:GetTagged (or the attribute) through eval_server_runtime or eval_client_runtime instead.

## Creating, duplicating, and deleting

- create_object sets name and every entry of properties first and assigns Parent last, so ChildAdded listeners and replication see a fully configured instance. There is no need, and no benefit, to pass Parent inside properties.
- Property assignment during creation is best-effort: each property is applied inside its own pcall, so a misspelled or invalid property is swallowed with no error in the response. When the value matters, verify afterwards with get_instance_properties, or set it with set_property, which does report failure.
- className must be a creatable class. Services, abstract classes, and non-creatable classes error, so check creatability and the exact spelling with get_class_info first.
- The create_object response returns the new instance's canonical instancePath and final Name. Use that returned path for follow-up calls rather than rebuilding it by hand, since a same-named sibling makes a hand-built path ambiguous.
- mass_create_objects processes entries strictly in array order and resolves each parent path at the moment that entry is created, so an entry may parent to an instance created earlier in the same call by naming its canonical path. Order children after their parents, and give parents explicit unique names so those paths are unambiguous.
- mass_create_objects is partial-success: each entry returns success plus the created instancePath, or an error such as "Parent instance not found" or "Class name and parent are required", alongside a total, succeeded, and failed summary. Per-entry properties are applied before parenting and invalid property names fail silently, and the entire batch is one undo recording.
- clone_object is a deep copy: the instance plus all descendants with their properties and attributes. An instance with Archivable=false clones to nil and the call fails, so set Archivable true first when the copy is intended.
- The copy keeps the original's Name, so cloning next to a same-named sibling makes canonical paths ambiguous. Use the returned instancePath immediately and rename the copy with set_property before doing anything else with it.
- A clone inherits the source's PackageLink, so the copy is still package-managed. clone_object is the right tool for a single copy landing under a specific different parent; for many copies with naming patterns or positional offsets prefer smart_duplicate or mass_duplicate.
- smart_duplicate offsets are cumulative by copy index (1-based): positionOffset adds offset times i studs, rotationOffset applies CFrame.Angles of offset times i degrees onto the clone's existing CFrame, and scaleOffset multiplies each Size axis by multiplier to the power of i (so 1 means leave this axis alone, not 0).
- positionOffset, rotationOffset, and scaleOffset are applied only when the clone IsA("BasePart"). For Models, Folders, GUI objects, or scripts they are silently ignored, so duplicate a Model by giving each copy a different parent or repositioning it afterwards.
- Without namePattern each copy is named SourceName followed by the index (Part1, Part2, ...). With it, every {n} in the pattern is replaced by the 1-based index.
- propertyVariations maps a property name to an array of values that cycles with modulo: copy i gets values[((i - 1) % #values) + 1], so a 3-value list repeats every 3 copies. A property that fails to set is swallowed per copy rather than failing the call.
- targetParents[i] is the parent for copy i. Copies past the end of the array, or entries whose path does not resolve, fall back to the source instance's own parent, which is also the default when targetParents is omitted.
- A smart_duplicate call is one ChangeHistoryService waypoint and returns per-copy results with each clone's new canonical instancePath plus a succeeded and failed summary; individual copies can fail without aborting the rest.
- Each entry in mass_duplicate behaves exactly like a single smart_duplicate call (same cumulative index-scaled offsets, {n} naming, cycling propertyVariations, and per-copy targetParents), so all of that guidance applies per entry. The difference is that mass_duplicate wraps the entire batch in one undo waypoint rather than one per entry, so a single undo reverses every copy it made. Prefer it over a loop of smart_duplicate calls when laying out many sources at once.
- mass_duplicate reports failures per entry and per copy and never aborts the batch. Read the top-level total, succeeded, and failed summary plus each entry's own results array to see which clones actually landed.
- delete_object calls Destroy(): the instance and every descendant are gone, the path stops resolving immediately, and any script references become destroyed instances. It is recorded in the change history so the user can undo it in Studio, but treat it as destructive and confirm the path first.
- The game root cannot be deleted; delete children of services instead. A path that no longer resolves returns "Instance not found" rather than deleting anything nearby.

## Packages and the modified badge

Studio does not reliably flag a Roblox Package as modified when its contents are changed through these tools, and an unmarked package can be silently reverted by package auto-update or "Get Latest". This applies to every write that touches an instance with a PackageLink-holding ancestor: script edits, property and attribute writes, tag adds and removes, duplication inside a package-managed model, and deletion.

The script tools help you catch it. set_script_source, edit_script_lines, insert_script_lines, and delete_script_lines return a packageWarning field when they touch a package-managed script, and find_and_replace_in_scripts returns packageWarnings with one entry per affected script. Surface those to the user.

For every other write there is no warning, so say so yourself: ask the user to confirm the package shows the modified badge before relying on the change. A one-character edit-and-undo in the Studio script editor forces the badge to appear.

## Selection and viewport

- selection with action=get returns the selected instances and is the tool to use when the user's Studio selection should define the scope. It replaces the older standalone selection getter.
- action=set applies paths with mode: set replaces the selection, add extends it, remove deselects. An empty paths array with mode=set clears the selection entirely.
- action=view points the edit-mode camera at a BasePart or Model given in path so the next capture_screenshot frames it. It moves the camera only; it does not change what is selected. The current viewing direction is preserved unless from or angleY overrides it.
- View camera conventions: from is azimuth in degrees around the target, where 0 looks from +X and 90 looks from +Z; angleY is elevation in degrees, positive values looking down at the target; padding is a distance scale, below 1 crops closer and above 1 pulls the camera back.
- For visual proof, change the instance, frame it with selection action=view, then call capture_screenshot.
- capture_screenshot grabs the viewport at native resolution and returns the image plus a text line with the exact pixel dimensions. It auto-detects a running playtest client and captures the live play viewport, otherwise it captures Edit mode.
- The screenshot is never downscaled, so its pixel grid is exactly the coordinate space simulate_mouse_input uses, with the top-left at (0,0). Read click positions straight off the returned image.
- For reading fine text or dense UI use format=png (lossless) or raise quality. jpeg at the default 92 is compact and crisp for 3D scenes, while png on a busy scene can be very large. Enlarging the Studio window is what actually raises captured resolution.
- capture_screenshot requires the EditableImage API enabled (Game Settings, Security, "Allow Mesh / Image APIs") and the Studio window visible on screen.
- StudioTestService multiplayer client screenshots are currently blocked by Roblox temporary-texture process scoping; the tool returns a clear error rather than an image in that case.

## Script changes

- Read the relevant source with get_script_source before changing it. The response carries both source (raw) and numberedSource (line-numbered); use the numbers from numberedSource when building line_range for edit_script_lines, insert_script_lines, or delete_script_lines.
- Without line_range, large scripts come back truncated to protect context. Check the truncated flag and the note field, and re-request specific ranges instead of assuming you saw the whole file.
- get_script_source line_range accepts "start-end" ("100-200"), open-ended ("100-" or "-200"), or a single line ("42"). All forms are 1-indexed and inclusive.
- edit_script_lines without line_range requires old_string to match exactly once in the whole script, so include surrounding lines to make it unique, or anchor the edit. Its line_range is a single 1-indexed line ("42") naming where old_string begins; passing it skips the uniqueness check and requires the match to start at exactly that line.
- insert_script_lines afterLine is 1-indexed and the content lands immediately after that line; pass 0 to insert at the very beginning of the script.
- delete_script_lines line_range is 1-indexed and inclusive on both ends, and only "start-end" or a single line ("42") are accepted; open-ended ranges are rejected for deletion. Deletion is destructive, so confirm the exact block with get_script_source first.
- Line numbers shift after every edit, insertion, or deletion, so re-read the script with get_script_source between successive line-numbered edits rather than reusing stale numbers.
- set_script_source replaces the entire script body, so anything not included in source is lost; for partial changes prefer the line tools. When you are rewriting rather than generating from scratch, read the current source first so a concurrent Studio edit is not clobbered.
- find_and_replace_in_scripts writes to every matching script in scope, so always run once with dryRun=true and review the preview before applying. Use grep_scripts when you only want to search.
- find_and_replace_in_scripts with usePattern=true requires caseSensitive=true, and the replacement can then reference Lua captures as %1, %2, and so on; a literal percent sign in the replacement must be escaped by doubling it.
- find_and_replace_in_scripts maxReplacements defaults to 1000 as a safety limit. If a run hits that cap the edit is partial, so narrow the scope with path or classFilter and rerun rather than assuming completion.
- grep_scripts groups results by script with line and column numbers; pair it with get_script_source to pull the surrounding code once you know where to look.
- grep_scripts defaults: literal search, caseSensitive false, contextLines 0, maxResults 100. The search stops at maxResults, so a capped result set may be incomplete.
- grep_scripts pattern mode supports top-level alternation with a vertical bar ("foo|bar" matches a line containing either) and is always case-sensitive; passing caseSensitive=false together with usePattern=true is rejected.
- On large places, survey first with filesOnly=true, then narrow with path ("game.ServerScriptService") and classFilter, and use maxResultsPerScript, like the -m flag of ripgrep, so one noisy script does not eat the whole budget.
- Both grep_scripts and find_and_replace_in_scripts take Lua patterns, not PCRE. See the pattern escaping rule under Discovery and edit work.
- After editing, compile-check the script with execute_luau (see Playtests and runtime Luau) and surface any packageWarning (see Packages and the modified badge).

## Playtests and runtime Luau

Start solo_playtest or multiplayer_playtest before targeting a live server or client, and stop the playtest when the scenario is complete.

- solo_playtest requires mode for action=start: play runs the place with a player character, run starts the server only. action=status reports the active runtime roles (server, client-N). timeout is in seconds and covers start readiness or stop teardown, defaulting to 60 for start and 15 for stop.
- The solo_playtest response carries brief lifecycle status only. Script output does not come back there: read it with get_runtime_logs after starting.
- Typical loop: start, then eval_server_runtime, eval_client_runtime, get_runtime_logs, capture_script_profiler, or capture_micro_profiler, then stop. Ordinary start, eval, and stop workflows do not need reset_simulation_state.
- For two or more client peers use multiplayer_playtest instead. It drives a StudioTestService session: action=start launches numPlayers clients (1 to 8), status inspects state, add_players adds more (also needs numPlayers), leave_client removes one client (target, for example "client-1", defaults to client-1), and end tears the session down. It also returns brief lifecycle status only.
- multiplayer_playtest testArgs must be a JSON-compatible table and is delivered to StudioTestService:GetTestArgs() on both the server and every client peer, so use it to parameterize a scripted test scenario. Its timeout (default 30 seconds) bounds how long start waits for peer detection or how long any other action waits to complete; raise it on heavy places that boot slowly.

execute_luau runs in a fresh plugin-context sandbox with PluginSecurity permissions. target accepts "edit" (the default), "server", and "client-1", "client-2", and so on for playtest peers. Output comes from print() and warn(), and the value the chunk returns is also captured.

- execute_luau with target=server or client-N reaches the live runtime DataModels but does not share the game's require cache, so module singletons required there are fresh copies.
- Compile-check an edited script without running the game by loading its source text through loadstring in execute_luau and printing the error, which catches syntax errors with line numbers. It does not type-check and does not run the game.

eval_server_runtime and eval_client_runtime run inside the running game's Script and LocalScript VMs, sharing the require cache with user game scripts, so requiring a module returns the same live singleton the game is using. Use them whenever module state or the runtime script environment matters; execute_luau cannot do this.

- Both eval tools require a running playtest. The runtime bridge is created automatically inside the play DataModel, including for playtests the user started manually with the Studio Play button, and client VMs are reached through an automatic server-side RemoteFunction broker, so no setup call is needed.
- Use return in the code to get a value back; otherwise only printed output is visible, which you read with get_runtime_logs.
- eval_client_runtime target defaults to "client-1"; pass "client-2", "client-3", and so on for the extra peers of a multi-client playtest. List live roles with get_connected_instances.

Read output with get_runtime_logs.

- Each plugin peer keeps an in-memory ring buffer of roughly 64 KB of recent LogService output, and the oldest entries are dropped once over budget, so poll during long runs rather than only at the end.
- Runtime peers seed from LogService:GetLogHistory() at plugin load, so startup logs emitted before the plugin finished loading are still returned. Seeded entries have no context dictionary (Roblox does not expose it for history), while live LogService.MessageOut entries include their structured context as an optional data field.
- target=all (the default) merges every buffer and dedups entries with the same message and level captured within 2 seconds across different buffers. Each entry carries capturedBy naming the buffer that observed it.
- In ordinary Studio play and run sessions LogService reflects logs across edit, server, and client, so script-origin peer is not reliable and entries omit peer. Only in multiplayer_playtest sessions is peer attribution reliable and included.
- Poll incrementally: pass the previous response's nextSince (single target) or the matching perCaptureNextSince entry (target=all) back as since. Filtering order is since, then filter (a plain literal substring, with no Lua pattern semantics), then tail.

## Simulation and input

- Inspect current settings with get_simulation_state before changing them. It reads NetworkSettings and StudioDeviceSimulatorService for the edit session and connected clients; server peers are always skipped, whatever target you pass. Defaults are include=both and target=edit-and-clients; narrow with target=edit, all-clients, or a specific client-N.
- get_simulation_state is not part of the ordinary playtest lifecycle. Reach for it when a task explicitly involves simulated network or device behavior, or when results look wrong and you suspect leftover simulation settings.
- set_network_profile requires a running playtest and applies only to client peers: pass target=client-1, client-2, ... or all-clients. Server peers cannot be targeted.
- Network presets, with total latency split evenly between in and out: great is 30ms (15/15), 0ms jitter, 0 percent loss; good is 100ms (50/50), 10ms jitter, 0 percent loss; poor is 300ms (150/150), 100ms jitter, 0.5 percent loss.
- profile=custom applies only the numeric overrides you pass, leaving every other field untouched. With a named preset, overrides replace the corresponding preset fields.
- Roblox caps simulated packet loss at 0.5 percent. InboundNetworkLossPercent and OutboundNetworkLossPercent above that are rejected outright, not clamped.
- Network conditions are applied through NetworkSettings in plugin context and persist until you change them or call reset_simulation_state. They do not clear when the playtest ends.
- reset_simulation_state sets all six simulated NetworkSettings fields (inbound and outbound min delay, jitter, and loss) to 0 and calls StopSimulationAsync() on the device simulator. Both are on by default; disable either with network=false or deviceSimulator=false. Default scope is target=edit-and-clients, and server peers are skipped regardless of target.
- Do not call reset_simulation_state as routine Studio hygiene. Call reset_simulation_state after a scenario in which you intentionally changed simulation settings, when get_simulation_state shows dirty state, or when a task needs a known-clean baseline.
- get_device_simulator_state is the source of valid deviceId values for set_device_simulator and capture_device_matrix. It returns the built-in preset list from GetDeviceListAsync (suppress with includeDeviceList=false), and passing deviceId asks for one preset's details through GetDeviceInfoAsync. Target defaults to edit and also accepts a regular playtest client such as client-1; server targets are rejected. When no device is being simulated, isSimulating is false and the active-device-only fields are omitted rather than returned empty.
- set_device_simulator supports built-in device presets only; custom device definitions are not available. Order of application is fixed: deviceId first, then orientation, resolution, pixelDensity, and scalingMode as overrides on top of the preset.
- orientation takes a ScreenOrientation enum name ("LandscapeRight", "LandscapeLeft", "Portrait") or a full Enum.ScreenOrientation string; scalingMode likewise takes a DeviceSimulatorScalingMode name ("ScaleToPhysicalSize") or the full Enum string.
- stopSimulation=true must be sent on its own; do not combine it with deviceId, resolution, or the other setters in the same call. set_device_simulator target defaults to edit and accepts client-N or all-clients, and server targets are rejected. Simulation persists until stopped, so clear it with stopSimulation or reset_simulation_state.
- capture_device_matrix accepts at most 6 entries and applies them in the order given, taking one viewport screenshot per entry. Each entry may set a deviceId plus the same overrides set_device_simulator takes. Target defaults to edit and accepts a regular playtest client such as client-1; both all-clients and server targets are rejected.
- capture_device_matrix restoreAfter (default true) restores the previous simulator state only when that prior state was default or a built-in preset. A custom active device is not preserved, since custom device persistence is intentionally unsupported, so re-apply it yourself afterwards.
- settleSeconds (default 0.3) is the pause after applying each entry before capture; raise it when UI needs time to relayout after a resolution or orientation change. Image options match capture_screenshot: format=jpeg (default, quality 1 to 100, default 92) is compact, while a full matrix of PNGs may exceed inline size limits.
- simulate_mouse_input and simulate_keyboard_input only work during a playtest. They drive UserInputService:CreateVirtualInput, so real UserInputService input fires, GUI buttons activate, and the default control modules respond.
- Capture the viewport with capture_screenshot before simulate_mouse_input so the pixel coordinates match: coordinates are viewport pixels with the top-left at (0,0), in exactly the pixel grid the screenshot returns.
- Only click, mouseDown, and mouseUp exist. The underlying API has no mouse-move and no scroll, so drags and hovers cannot be simulated.
- simulate_keyboard_input action=tap (the default) is press, wait duration, release, with duration in seconds (default 0.1). For sustained movement send action=press to hold the key and a later action=release to let go; a tap alone gives only a twitch of movement. W, A, S, and D walk the character at full WalkSpeed with player controls intact.
- keyCode is an Enum.KeyCode name: "W", "A", "S", "D", "Space", "E", "F", "LeftShift", "LeftControl", "Return", "Tab", "Escape", "One", "Two", and so on.
- Pass text instead of keyCode to type a whole string into the currently focused TextBox through SendTextInput. When text is present, keyCode and action are ignored, so focus the TextBox first with a simulate_mouse_input click.
- Both input tools auto-resolve target to the running playtest client (client-1) when one exists, else edit. Override with "server", "client-2", and so on; keyboard input should target a live client when game input is under test.

## Debugging and profiling

- breakpoints manages Studio debugger breakpoints through ScriptDebuggerService and requires the Studio Debugger Luau API beta feature to be enabled. It only manages breakpoint lifecycle: it does not pause, resume, step, inspect variables, or install OnStopped callbacks.
- Prefer log breakpoints for agent debugging: pass log_message and let continue_execution default to true. Minimal flow: set a log breakpoint, run or trigger the behavior, call get_runtime_logs with filter="Breakpoint", then action=clear to remove the tool-created breakpoints.
- Generated logs are prefixed with "Breakpoint" plus script_path:line, and Studio's own breakpoint errors also start with "Breakpoint", so filtering runtime logs on that word captures both successful logs and breakpoint-related failures.
- log_message is a Studio breakpoint log expression list, for example: 'health', health. Literal text must be quoted as a Luau string or it is evaluated as an expression.
- Footgun: do not set continue_execution=false unless the target DataModel already has an OnStopped resume handler on ScriptDebuggerService, one that returns Enum.DebuggerResumeType.Resume for breakpoint and other non-exception stops. Without it the playtest can get stuck and MCP can lose the server and client peers. Minimal reference handler:

      local sds = game:GetService("ScriptDebuggerService")
      sds.OnStopped = function(info)
          if info.Reason ~= Enum.ScriptStoppedReason.Exception then
              return Enum.DebuggerResumeType.Resume
          end
          print("EXCEPTION:", info.ExceptionText)
          return Enum.DebuggerResumeType.Resume
      end

- Set breakpoints on target=edit (the default) before starting a playtest when possible; for an already-running playtest, target the runtime DataModel directly with "server" or "client-1".
- action=list is scoped the same way as clear: it returns only breakpoints created through this tool in the targeted DataModel, so a short or empty list never proves the place has none. Breakpoints the user set by hand in Studio are invisible to it.
- Destructive: by default action=clear removes only MCP-created breakpoints, the ones this tool set itself. Pass clear_all=true only when you deliberately want ScriptDebuggerService:ClearBreakpoints() to wipe every Studio breakpoint in the targeted DataModel, including the user's own.
- Minimal script_path and line recovery data is persisted per place and target, so action=list and action=clear still find tool-created edit, server, and client breakpoints after an MCP or plugin reload. script_path is a canonical LuaSourceContainer path such as game.ServerScriptService.Main or game.ServerScriptService[".dir"].ReproScript, and line is 1-based.
- capture_script_profiler ranks Luau functions by CPU time and is for script optimization only. It does not cover render, physics, networking, or engine microprofiler lanes; use capture_micro_profiler for those. target=edit is invalid because ScriptProfiler samples running code, so profile "server" (the default) or a specific "client-N"; discover available runtime roles with get_connected_instances.
- Minimal flow: start or reproduce the workload, capture, inspect top_functions, patch the suspected hot path, then capture again with identical target, workload, duration_ms, frequency, filter, and min_total_us so the two runs are comparable.
- total_us is cumulative profiler TotalDuration in microseconds during the capture, in the Roblox exported Script Profiler JSON format. Nested labels and functions overlap, so never sum rows to get total CPU time.
- top_functions is sorted by descending total_us after native, plugin, min, and filter exclusions. Each row carries rank plus function_index, the 1-based index into the raw Roblox Functions array. source is the runtime script path reported by Roblox and may need mapping back to editable source with grep_scripts or search_files.
- When function names are too broad, wrap suspect code in debug.profilebegin("Area:SpecificStep") and debug.profileend() and pass filter="Area:". Matching custom labels appear in debug_labels and top_functions with their script source and no line number.
- The result echoes effective options in applied, and omitted.filtered_out counts rows removed by filter. Native and plugin frames are excluded by default to keep output focused on game Luau.
- Keep captures short while actively triggering the behavior: duration_ms defaults to 1000 and is clamped to 100 to 15000. Pass output_path to write the raw Roblox Script Profiler JSON for offline comparison. The tool owns one start, stop, and request lifecycle per call and exposes no long-lived profiler sessions.
- capture_micro_profiler attributes frame time engine-wide by sampling the Roblox MicroProfiler through LibMP on a running server (the default) or client-N peer. Reach for it when the question is where frame time is going across scripts, physics, render, network, jobs, scheduler, and GC; use capture_script_profiler when you only need per-function Luau CPU.
- Units: all times are microseconds, converted from LibMP nanosecond ticks. inclusive_us is cumulative nested timer time and can overlap across timers and threads, so do not sum them as disjoint totals: adding rows never gives total frame time.
- Normalization: the per-second fields are divided by analysis_window.analysis_duration_us, not by the requested duration_ms. pct_of_analyzed_wall can legitimately exceed 100 when work overlaps.
- Primary data is top_groups and top_timers sorted by inclusive_us, with exclusive-sorted companion lists, top_threads, top_call_edges, frame_summary, and analysis_window and data_quality so you can tell whether a result is steady, spiky, thread-bound, wrapper-heavy, or truncated. recommended_tools is deliberately brief; the point is digestible attribution data, not a canned diagnosis.
- Triggered spike captures: action=arm enables the profiler, starts a Heartbeat watcher, and returns a capture_id immediately without blocking; action=collect polls it (status is armed, triggered, done, timed_out, cancelled, or failed) and returns the analysis once done; action=cancel aborts a capture that is still armed or has already triggered but not yet been collected, discarding its snapshot.
- filter is a case-insensitive substring over timer and group names. Luau timers are prefixed $Script, so filter="$Script" isolates script work; other useful families are Heartbeat, Simulation, and RbxTransport.
- Trigger kinds: frame_time fires on the first new, complete, non-paused frame at or above threshold_ms and is the main one, so frames elapsed while Studio sits paused at a breakpoint never trigger it; attribute fires when name on instance changes to a truthy value, or to value when given, which lets a server script trigger a capture on a client peer; log fires on a LogService message containing substring (plain text, not a pattern), handy in single-player playtests where the client log reflects both peers. arm_timeout_ms defaults to 60000 before timed_out.
- For triggered captures the analysis window is trigger_frame_id minus frames_before through trigger_frame_id plus post_trigger_frames, and it is walked from the trigger frame first, so max_events can never cut off the spike itself.
- Ring limit: frames_before plus post_trigger_frames must stay at or below 240 because the MicroProfiler ring holds 256 frames; frames_before is silently reduced to fit when it does not. Defaults are 8 and 30.
- action=analyze re-runs the analysis over an already stored snapshot with different focus, filter, or include_sections and no new capture. Only the last 3 captures are retained, for 10 minutes. Pass the capture_id; when target is omitted the server routes collect, cancel, and analyze back to the peer the capture was armed on.
- frame_breakdown gives per-frame top timers by exclusive time for the longest frames in the window, plus the trigger frame (always added when not already among them), so one spike frame can be read directly instead of inferred from window aggregates. max_frame_breakdowns defaults to 3; use 0 to omit the section.
- To keep replies small, the inline response carries only frame_summary, frame_breakdown, top_groups, top_timers, and data_quality. Ask for top_groups_by_exclusive, top_timers_by_exclusive, top_threads, or top_call_edges through include_sections (or "all"), and sections_omitted names whatever was trimmed. summary_output_path always receives the full untrimmed response.
- Baseline workflow: capture an empty baseplate or control run with the same target and settings and a summary_output_path, then capture the game again supplying that earlier result through baseline_path or baseline. baseline_path points at the saved JSON; pass baseline inline only when the prior capture is already in context. Saved summaries include a compact comparison_index so baseline_comparison diffs full compact aggregates rather than only the visible top rows; deltas are current minus baseline, normalized by capture duration.
- max_events (default 250000) bounds iterator work. event_limit_hit and partial_reasons tell you when rankings are useful but partial: narrow focus or filter, or raise max_events, for deeper analysis. focus restricts to script, physics, render, network, or jobs; start with "all" for unknown bottlenecks and narrow after top_groups identifies the area.
- duration_ms defaults to 1000 and is clamped to 100 to 5000 because decoded MicroProfiler event streams are far larger than ScriptProfiler output. Aggregation is time-budgeted so captures do not freeze gameplay, and the first capture in a session absorbs a warmup of roughly 24 frames.
- include_idle defaults false so Sleep and idle noise is omitted, since idle time usually hides the actionable engine work; include_gpu defaults false to keep CPU diagnosis focused. output_path writes the raw snapshot bytes while the normal response stays summarized.
- get_memory_breakdown iterates Enum.DeveloperMemoryTag and calls Stats:GetMemoryUsageMbForTag per item, plus Stats:GetTotalMemoryUsageMb for the rollup. This is a workaround because Stats:GetMemoryUsageMbAllCategories is gated by Capabilities: InternalTest and is not callable from plugin context.
- get_memory_breakdown shape depends on target: target=all (the default) returns a map of peer to total_mb, categories, and timestamp for every connected peer except edit-proxy, while a single-peer target returns that peer's object directly. timestamp is Unix milliseconds. The optional tags whitelist filters to just those DeveloperMemoryTag entries; unknown tag names come back with value 0 and are listed in unknown_tags so cross-version drift does not error the call. A peer with MemoryTrackingEnabled=false surfaces as an error on that peer only, and the other peers still return data.
- get_scene_analysis reads Roblox SceneAnalysisService data and complements get_memory_breakdown: it returns compact top-N entries for instance composition, script memory, unparented instances, triangle composition, animation memory, and audio memory. Pick one with mode, or "all".
- get_scene_analysis requires the Studio Scene Analysis beta feature. When it is disabled the call returns scene_analysis_not_enabled with betaFeatureRequired=true; tell the user to enable the beta rather than retrying.
- get_scene_analysis target=all (the default) returns per-peer data, while a single-peer target returns that peer's data directly. topN is the number of flattened top entries per mode (default 10, clamped by the plugin to 1 to 100), and raw=true additionally includes the full nested Scene Analysis tree in each mode result, which is large.

## Creator Store and generated assets

Search with search_assets, inspect a shortlist with get_asset_details or get_asset_thumbnail, and preview untrusted content with preview_asset before insert_asset. That order keeps context small.

- search_assets needs no Roblox credentials and returns compact normalized rows: assetId, name, a normalized description excerpt, and audio duration in seconds when available. maxResults defaults to 25 and is capped at 100.
- assetType "Image" maps to Decals, while "Particle" and "VFX" map to effect-focused Model searches and append an effect-specific suffix to the query when needed. Useful particle and VFX query terms: particle effect, VFX, explosion, smoke, aura, beam, trail, impact effect.
- All creators are searched by default; robloxCreatedOnly=true restricts to Roblox-account assets. Creator identity does not change insertion safety: every inserted asset is sanitized regardless of creator, reputation, or verification.
- get_asset_details reads public Creator Store metadata and needs no credentials. Call it only for a shortlisted asset whose full metadata you actually need. get_asset_thumbnail returns a base64 PNG suitable for vision models, also with no credentials, in 150x150, 420x420 (the default), or 768x432.
- Studio must allow third-party asset loading for public third-party previews and insertion (Game Settings, Security, "Allow Loading Third Party Assets"). Tell the user to turn it on if a preview or insertion fails for that reason.
- preview_asset never touches the place: the asset stays unparented and is destroyed afterward, and its unlimited-depth security and capability scan scans the complete hierarchy without returning script source, so it is safe on untrusted assets. Imported script source is never read or exposed; you get normalized capabilities, sound references, and explicit script and PackageLink counts, which tell you exactly what insert_asset would strip.
- preview_asset maxDepth (default 4) only limits the displayed hierarchy, which is additionally capped at 100 nodes; the security scan always traverses every descendant regardless. includeProperties is opt-in because it is verbose.
- Direct Creator Store Audio IDs and accessible nested Sound or AudioPlayer references return temporary inline audio by default (includeAudio, up to maxAudioPreviews, default 3 and max 5). Those downloads need ROBLOX_OPEN_CLOUD_API_KEY with the asset:read scope, are never persisted to disk, and are subject to fixed per-file and combined byte limits. Set includeAudio=false for metadata only.
- insert_asset is sanitizing by design: the loaded asset is forced to stay unparented while every descendant is scanned at unlimited depth, and that pass removes every LuaSourceContainer and PackageLink it finds (Script, LocalScript, ModuleScript, and future subclasses), destroying them without inspecting or exposing their source. Do not use it to import scripted systems, they will arrive stripped.
- insert_asset strips, then scans again before insertion: that second unlimited-depth scan must find zero forbidden instances before anything is parented, otherwise the whole loaded asset is destroyed and nothing is inserted, all-or-nothing. Names, Unicode, nesting depth, creator verification, contents, and reputation never relax this policy.
- Purely visual objects survive sanitization: ParticleEmitter, Beam, Trail, Attachment, Decal, Texture, meshes, lights, sounds, Fire, Smoke, and Sparkles. insert_asset position is a world position in studs (x, y, z); omit it to let the asset land where it loads, then move it with the ordinary instance tools.
- generate_model stages generated content under ServerStorage and nowhere else: it calls GenerationService:GenerateModelAsync and parents the result under game.ServerStorage.__MCPGeneratedModels. Parenting, positioning, scaling, anchoring, and world integration are follow-up calls with the ordinary instance tools.
- Its output is intentionally tiny: success returns only success and modelPath, failure returns only success and error. Inspect the staged model with the instance tools if you need more.
- Provide at most one image input to generate_model, and exactly one when using an image: image_path, image_base64, or image_asset_id. image_base64 also requires image_mime_type="image/png", the only supported format. Roblox accepts image inputs only as rbxassetid or rbxasset URIs, so image_path and image_base64 are uploaded as Roblox Decal or Image assets first using the configured upload credentials; pass image_asset_id to reuse an existing asset and skip that upload.
- generate_model schema defaults to Body1 (one mesh). Use Car5 only for a five-part vehicle chassis, or schema_groups for custom segmentation such as Body, Front Left Wheel, Front Right Wheel, Rear Left Wheel, Rear Right Wheel. schema and schema_groups are mutually exclusive.
- generate_model size x, y, and z are approximate studs, not a contract: GenerationService may not match them exactly. max_triangles lowers detail into faceted, low-poly territory. timeout_ms is the MCP bridge wait in milliseconds, default 120000.
- upload_asset sends an explicit local file to the chosen Roblox user or group. Accepted formats by assetType: Audio (mp3, ogg, wav, flac), Decal (png, jpg, bmp, tga), Model (fbx, gltf, glb, rbxm, rbxmx), Animation (rbxm, rbxmx), Video (mp4, mov). The file must actually match the declared type.
- upload_asset auth: Decal can use ROBLOSECURITY cookie auth through the Asset Manager user-auth API, which returns the direct Image asset ID, or ROBLOX_OPEN_CLOUD_API_KEY. Every other type requires an Open Cloud API key with the asset:write scope plus a creator ID.
- Creator ID resolution: userId overrides ROBLOX_CREATOR_USER_ID, groupId overrides ROBLOX_CREATOR_GROUP_ID, and groupId takes precedence when both are supplied.
- Roblox platform limits apply: Audio is capped at 7 minutes with 100 uploads per month for ID-verified accounts, Video is capped at 5 minutes and requires a 13+ ID-verified account, and displayName is limited to 50 characters.

## RBXM files

- export_rbxm writes selected instances to an explicit local path. It uses SerializationService:SerializeInstancesAsync, which needs engine v668 or newer and PluginSecurity, so older Studio builds fail the call.
- It throws if any entry in instance_paths resolves to nil, to a service, or to a non-creatable instance. Export the children of a service, not the service itself.
- export_rbxm target="server" serializes live runtime state from the play-server DataModel during a playtest, which is how you snapshot something that only exists at runtime; "edit" (the default) reads the edit DataModel. output_path must be an absolute filesystem path and is written by the MCP server process, not by Studio.
- import_rbxm uses SerializationService:DeserializeInstancesAsync, which also needs engine v668 or newer and PluginSecurity. Supply exactly one of source.path, source.url, or source.base64. path and url are read or fetched by the MCP server process, not Studio; url must be http or https and is capped at 50 MiB.
- import_rbxm parents imported instances under the supplied canonical path, all-or-nothing: if any single instance fails to parent, every already-parented sibling is unparented again and the call errors, so a failed import leaves no partial content behind.
- With target="edit" (the default) the import is wrapped in ChangeHistoryService, so a single Ctrl+Z reverses the whole import. target="server" parents into the live play-server DataModel during a playtest and is not undoable that way.
- Unlike Creator Store insertion, import_rbxm does not strip scripts: an .rbxm you import keeps its LuaSourceContainers, so only import files you trust.

## Studio processes

manage_instance can launch, inspect, and close Studio or list published place revisions. Keep its launch_id until the connection has an instance_id.

- Every action=launch returns launch_id, the native pid, the source, and a lifecycle state. status and close accept launch_id before the plugin has connected and instance_id after association; the two are mutually exclusive on one call. launch_id keeps working after a launch reaches a terminal state (crashed, failed to connect, closed), which is how you read back why a launch that never connected ended.
- Launch sources: "baseplate" opens a blank place, and "local_file" opens local_place_file (a .rbxl or .rbxlx path). Neither uses place_id, so do not pass it for those.
- source="published_place" opens the latest published place and is blocked if that place_id is already connected. source="place_revision" (with place_id and place_version) is allowed even then, because Studio opens explicit past revisions as anonymous local copies.
- Discover version numbers with action=list_place_versions and a place_id. It reads Open Cloud asset versions and requires ROBLOX_OPEN_CLOUD_API_KEY with the asset:read scope. max_page_size is clamped to 1 to 50 (default 10), and page_token continues a prior listing.
- require_process_identity=true runs the protocol-v3 flow: it captures an exact native PID and process creation time, returns launch_id immediately, and leaves the process suspended. Such a launch must be authorized and completed explicitly: call action=authorize once process-scoped injection is prepared, then action=complete only after the injected runtime has been independently attested; complete releases broker ownership of the process.
- If identity capture, authorization, or ownership completion fails under require_process_identity, the broker stops the launched process. That mode also ignores wait_for_connection and timeout_ms, using the broker ownership-completion lease through complete instead.
- wait_for_connection=false returns launch_id immediately and keeps tracking association and failure asynchronously; timeout_ms (default 120000) still applies to that asynchronous deadline.
- process_environment.set and process_environment.remove are applied only while creating the Studio process and are never retained in the managed-instance registry. studio_working_directory isolates relative plugin folders so parallel launches do not share a single plugin directory.

## Roblox reference material

- get_class_info reads the official API dump matched to the connected Studio version: every property, method, event, and callback with exact signatures and types, plus Yields, Deprecated, and ReadOnly tags and security tags such as PluginSecurity and RobloxScriptSecurity.
- Members inherited from ancestors are labeled with inheritedFrom, and the result also carries the full superclass chain and the direct subclasses, so use it to find which ancestor actually defines a member and what else derives from it.
- If the version-matched API dump is unavailable (offline), get_class_info silently falls back to probing a live instance, which returns much less: no exact signatures, no security or Yields and Deprecated tags, and members that require a particular instance state may be missing entirely.
- get_roblox_docs fetches official create.roblox.com pages as markdown, including the description, properties, methods, events, and code samples. Reach for it before writing code that touches an API you are not fully certain about (ProximityPrompt, Enum.KeyCode, CFrame, TweenService), not after the bug appears.
- Its name must be the exact PascalCase API name, and doc_type picks the category: classes by default, plus enums, datatypes, libraries, and globals. Enum members are looked up by the enum name alone, for example "KeyCode", not "Enum.KeyCode.E".
- An unresolved name is not a dead end: the response carries ranked recommendations from the official engine index, including matching pages in other doc categories, so retry with a suggested name and doc_type.
- Very large pages are truncated and come back with a section index. Pass section ("Description", "Properties", "Methods", "Events", "Code Samples") to read one section in full. Results are cached, so repeat lookups are cheap.
- get_roblox_skills lists or reads Roblox-authored Studio Assistant skills when their longer guidance is useful. It reads the locally installed Assistant.rbxm directly, so it works with no connected Studio place and does not depend on Roblox's built-in MCP.
- Call action="list" first to discover the available skill names, then action="get" with name for the exact Markdown. Both the canonical rbx-* names and the embedded source names are accepted.
`;

/** The guide split by heading, so clients can read one section instead of all of it. */
export const TOOL_GUIDE_SECTIONS: readonly ToolGuideSection[] = parseToolGuideSections(TOOL_GUIDE_MARKDOWN);

/** Look up one guide section by its URI slug. */
export function findToolGuideSection(slug: string): ToolGuideSection | undefined {
  return TOOL_GUIDE_SECTIONS.find((section) => section.slug === slug);
}

/** Official Roblox reference templates shared by the HTTP and stdio servers. */
export function registerResourceHandlers(server: McpServer): void {
  server.registerResource(
    'Roblox Studio MCP tool guide',
    TOOL_GUIDE_URI,
    {
      description: 'Detailed workflows and safety notes for Roblox Studio MCP tools.',
      mimeType: 'text/markdown',
    },
    async (resourceUrl) => ({
      contents: [{
        uri: resourceUrl.href,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }],
    }),
  );

  // The whole guide is large, so each heading is also addressable on its own. Clients that
  // need one topic can read that section instead of paying for the entire document.
  server.registerResource(
    'Roblox Studio MCP tool guide section',
    new ResourceTemplate(`${TOOL_GUIDE_SECTION_URI_PREFIX}{section}`, {
      list: () => ({
        resources: TOOL_GUIDE_SECTIONS.map((section) => ({
          uri: `${TOOL_GUIDE_SECTION_URI_PREFIX}${section.slug}`,
          name: `Tool guide: ${section.title}`,
          description: `The "${section.title}" section of the Roblox Studio MCP tool guide.`,
          mimeType: 'text/markdown',
        })),
      }),
      complete: {
        section: (value) => TOOL_GUIDE_SECTIONS
          .map((section) => section.slug)
          .filter((slug) => slug.startsWith(value.toLowerCase())),
      },
    }),
    {
      description: 'One section of the Roblox Studio MCP tool guide, addressed by its heading slug.',
      mimeType: 'text/markdown',
    },
    async (resourceUrl, variables) => {
      const raw = variables.section;
      const slug = Array.isArray(raw) ? raw[0] : raw;
      const section = typeof slug === 'string' ? findToolGuideSection(slug) : undefined;
      if (!section) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Resource ${resourceUrl.href} not found. Valid tool guide sections: ${TOOL_GUIDE_SECTIONS.map((entry) => entry.slug).join(', ')}.`,
        );
      }
      return {
        contents: [{
          uri: resourceUrl.href,
          mimeType: 'text/markdown',
          text: section.markdown,
        }],
      };
    },
  );

  const templates = [
    ['classes', 'className', 'Roblox class documentation', 'Official Roblox engine class reference.'],
    ['enums', 'enumName', 'Roblox enum documentation', 'Official Roblox engine enum reference.'],
    ['datatypes', 'dataTypeName', 'Roblox datatype documentation', 'Official Roblox engine datatype reference.'],
    ['libraries', 'libraryName', 'Roblox library documentation', 'Official Roblox Luau library reference.'],
    ['globals', 'globalsPage', 'Roblox globals documentation', 'Official Roblox globals reference.'],
  ] as const;

  for (const [category, variable, name, description] of templates) {
    server.registerResource(
      name,
      new ResourceTemplate(`robloxdocs://${category}/{${variable}}`, { list: undefined }),
      { description, mimeType: 'text/markdown' },
      async (resourceUrl) => {
        const uri = resourceUrl.href;
        const match = uri.match(/^robloxdocs:\/\/([^/]+)\/([^/]+)$/);
        if (!match || !isDocCategory(match[1])) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} not found`);
        }

        const [, docCategory, rawName] = match;
        const docName = decodeURIComponent(rawName);
        try {
          const content = await fetchRobloxDoc(docCategory, docName);
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: content }],
          };
        } catch (error) {
          if (error instanceof DocNotFoundError) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${uri} not found. Names are case-sensitive PascalCase; valid categories: ${DOC_CATEGORIES.join(', ')}.`,
            );
          }
          console.error(`[resource:${uri}]`, error);
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to read ${uri}.`);
        }
      },
    );
  }
}
