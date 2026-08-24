# 3.0 tool removals (not adopted by this fork)

Upstream version 3.0 removed the tools below, replacing them with `execute_luau`
recipes and a few consolidated tools. **This fork keeps most of them.** The table is kept
as a map of upstream-equivalent workflows, not as a list of things you can no
longer call here.

Two sets of exceptions apply.

The deprecated playtest aliases (`start_playtest`, `stop_playtest`,
`multiplayer_test_*`) stay hidden from the advertised catalog but remain
callable, exactly as before.

The build-library tools (`create_build`, `generate_build`, `get_build`,
`import_build`, `export_build`, `list_library`, `import_scene`,
`search_materials`) and the `get_selection`, `undo`, and `redo` tools have since
been removed from this fork as well. They are gone from `tools/list` and from
the `/mcp/<tool>` routes; the replacements in the table below apply. Rows for
these tools are marked **removed here** in the table.

Upstream's replacements, for reference:

| Removed tool | Replacement |
| --- | --- |
| `start_playtest`, `stop_playtest` | `solo_playtest` with `action: "start"` or `"stop"` |
| `multiplayer_test_start` | `multiplayer_playtest` with `action: "start"` |
| `multiplayer_test_state` | `multiplayer_playtest` with `action: "status"` |
| `multiplayer_test_add_players` | `multiplayer_playtest` with `action: "add_players"` |
| `multiplayer_test_leave_client` | `multiplayer_playtest` with `action: "leave_client"` |
| `multiplayer_test_end` | `multiplayer_playtest` with `action: "end"` |
| `get_selection` (**removed here**) | `selection` with `action: "get"` |
| `get_file_tree` | `get_project_structure` |
| `search_files` | `search_objects` for instances; `grep_scripts` for source |
| `search_by_property` | `search_objects` with `searchType: "property"` |
| `get_class_info` | `get_roblox_docs` or a `robloxdocs://classes/{className}` resource |
| `export_build`, `create_build`, `generate_build`, `import_build`, `list_library`, `get_build`, `import_scene` (**removed here**) | Project-local Luau modules or agent skills backed by `execute_luau` and retained focused tools |
| `search_materials` (**removed here**) | Query `MaterialService` with `execute_luau` |
| `smart_duplicate`, `mass_duplicate` | Project-specific cloning or patterned duplication with `execute_luau` |
| `compare_instances` | Read both objects with `get_instance_properties`, or compute a project-specific diff with `execute_luau` |
| `get_services`, `get_instance_children`, `get_descendants` | `get_project_structure` or `search_objects` for ordinary discovery; `execute_luau` for custom traversal |
| `set_property` | `set_properties` with a one-property object |
| `mass_set_property`, `mass_get_property` | A project-specific loop with `execute_luau` |
| `create_object`, `mass_create_objects`, `delete_object`, `clone_object` | Create, destroy, or clone instances with `execute_luau` |
| `set_attribute`, `delete_attribute`, `bulk_set_attributes` | Set or clear attributes with `execute_luau`; `get_attributes` remains for compact reads |
| `get_tags`, `add_tag`, `remove_tag`, `get_tagged` | Use `CollectionService` through `execute_luau` |
| `undo`, `redo` (**removed here**) | Use `ChangeHistoryService` through `execute_luau` when a custom workflow needs history control |

Every other name in the table remains in both `tools/list` and the direct
`/mcp/<tool>` compatibility routes. The deprecated playtest aliases are routable
but unadvertised, and the rows marked **removed here** are not available at all.
