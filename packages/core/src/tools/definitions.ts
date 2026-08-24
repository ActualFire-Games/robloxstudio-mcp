import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { MAX_PNG_BASE64_CHARACTERS } from '../image-decode.js';

export type ToolCategory = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: object;
  outputSchema?: object;
  annotations?: ToolAnnotations;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // === File & Instance Browsing ===
  {
    name: 'get_file_tree',
    category: 'read',
    description: 'Use to dump the complete instance tree under a path when you need every descendant, not a bounded preview.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'DataModel path to start from, defaults to the game root.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'search_files',
    category: 'read',
    description: 'Use to locate instances anywhere in the place by name, by class name, or by text inside script source.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match, case insensitive and read as a Lua pattern.'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'type', 'content'],
          description: 'Field to match; defaults to name, content scans script text.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['query']
    }
  },

  // === Place & Service Info ===
  {
    name: 'get_place_info',
    category: 'read',
    description: 'Use to identify the connected place (published name, place and game IDs, job ID) before acting on it.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'get_services',
    category: 'read',
    description: 'Use to list a Studio service and its immediate children while orienting yourself in an unfamiliar place.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description: 'Single service to describe; omit to list all services.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'search_objects',
    category: 'read',
    description: 'Use to find instances across the whole place by name, by class, or by the value of one named property.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match, case insensitive and read as a Lua pattern.'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'class', 'property'],
          description: 'Field to match; defaults to name, property needs propertyName.'
        },
        propertyName: {
          type: 'string',
          description: 'Property to read; used only when searching by property.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['query']
    }
  },

  // === Instance Inspection ===
  {
    name: 'get_instance_properties',
    category: 'read',
    description: 'Use to read one instance\'s common properties, script source, and child count in a single call.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Full DataModel path of the instance to read.'
        },
        excludeSource: {
          type: 'boolean',
          description: 'Skip script source, return only its length and line count.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'get_instance_children',
    category: 'read',
    description: 'Use to list the direct children of one instance with their class names, without recursing any deeper.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Full DataModel path of the parent to list.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'search_by_property',
    category: 'read',
    description: 'Use to find every instance whose given property matches a value when you do not know where they live.',
    inputSchema: {
      type: 'object',
      properties: {
        propertyName: {
          type: 'string',
          description: 'Property to read on each instance, skipped where absent.'
        },
        propertyValue: {
          type: 'string',
          description: 'Substring matched against the value, case insensitive.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['propertyName', 'propertyValue']
    }
  },
  {
    name: 'get_class_info',
    category: 'read',
    description: 'Use to look up a Roblox class\'s exact properties, methods, events, and type signatures before writing code.',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Exact Roblox class name, case sensitive'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['className']
    }
  },

  // === Project Structure ===
  {
    name: 'get_project_structure',
    category: 'read',
    description: 'Use to survey the place hierarchy at a bounded depth, starting from a service overview when no path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Where to start; omit for a services overview of the place.'
        },
        maxDepth: {
          type: 'number',
          description: 'Levels below the start path to expand, defaults to 3.'
        },
        scriptsOnly: {
          type: 'boolean',
          description: 'Keep only scripts, modules, and folders, defaults to false.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },

  // === Property Write ===
  {
    name: 'set_property',
    category: 'write',
    description: 'Use to change one property on one instance when you already know its path and the property name.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to change'
        },
        propertyName: {
          type: 'string',
          description: 'Exact property name, case sensitive'
        },
        propertyValue: {
          description: 'New value; arrays or {X,Y,Z} objects become Vector3/Color3'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_set_property',
    category: 'write',
    description: 'Use to apply the same property value across many instances in one call instead of one call each.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical paths; a missing one fails alone, not the batch'
        },
        propertyName: {
          type: 'string',
          description: 'Exact property name, case sensitive'
        },
        propertyValue: {
          description: 'One value for every path; arrays map to Vector3/Color3'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['paths', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_get_property',
    category: 'read',
    description: 'Use to read one property across many instances at once when auditing or comparing them.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical paths; each reports its own success or error'
        },
        propertyName: {
          type: 'string',
          description: 'Exact property name, case sensitive'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['paths', 'propertyName']
    }
  },
  {
    name: 'set_properties',
    category: 'write',
    description: 'Use to configure several properties on a single instance in one call, typically right after creating it.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to change'
        },
        properties: {
          type: 'object',
          description: 'Name to value map; each applies alone, order not fixed'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'properties']
    }
  },

  // === Object Creation/Deletion ===
  {
    name: 'create_object',
    category: 'write',
    description: 'Use to add one new instance under a chosen parent, optionally with its starting properties.',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Creatable Roblox class name, case sensitive'
        },
        parent: {
          type: 'string',
          description: 'Canonical path of the parent, which must already exist'
        },
        name: {
          type: 'string',
          description: 'Name for the new instance, defaults to the class name'
        },
        properties: {
          type: 'object',
          description: 'Applied before parenting; bad names fail silently'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['className', 'parent']
    }
  },
  {
    name: 'mass_create_objects',
    category: 'write',
    description: 'Use to build a whole batch of instances in one call, such as parts, folders, or value objects.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Creatable Roblox class name, case sensitive'
              },
              parent: {
                type: 'string',
                description: 'Canonical parent path, existing or made earlier in the array'
              },
              name: {
                type: 'string',
                description: 'Name for the new instance, defaults to the class name'
              },
              properties: {
                type: 'object',
                description: 'Applied before parenting; bad names fail silently'
              }
            },
            required: ['className', 'parent']
          },
          description: 'Created in array order, so later ones can nest in earlier'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['objects']
    }
  },
  {
    name: 'delete_object',
    category: 'write',
    description: 'Use to permanently remove an instance and everything under it from the place.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to destroy, descendants included'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },

  // === Duplication ===
  {
    name: 'smart_duplicate',
    category: 'write',
    description: 'Use to duplicate one instance N times with stepped names, offsets, and property variations.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the source instance to copy.'
        },
        count: {
          type: 'number',
          description: 'How many copies to make, indexed 1 to count.'
        },
        options: {
          type: 'object',
          description: 'Naming and transform variations applied per copy.',
          properties: {
            namePattern: {
              type: 'string',
              description: 'Name template, {n} becomes the 1-based copy index.'
            },
            positionOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'Studs added per copy, multiplied by the copy index.'
            },
            rotationOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'Degrees added per copy, multiplied by the copy index.'
            },
            scaleOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'Size multipliers compounded, raised to the copy index.'
            },
            propertyVariations: {
              type: 'object',
              description: 'Property name to value list, cycled across copies.'
            },
            targetParents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Parent path per copy, index 1 is the first copy.'
            }
          }
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'count']
    }
  },
  {
    name: 'mass_duplicate',
    category: 'write',
    description: 'Use to run several independent duplication jobs on different sources in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        duplications: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              instancePath: {
                type: 'string',
                description: 'Canonical path of the source instance to copy.'
              },
              count: {
                type: 'number',
                description: 'How many copies to make, indexed 1 to count.'
              },
              options: {
                type: 'object',
                description: 'Naming and transform variations applied per copy.',
                properties: {
                  namePattern: {
                    type: 'string',
                    description: 'Name template, {n} becomes the 1-based copy index.'
                  },
                  positionOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Studs added per copy, multiplied by the copy index.'
                  },
                  rotationOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Degrees added per copy, multiplied by the copy index.'
                  },
                  scaleOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Size multipliers compounded, raised to the copy index.'
                  },
                  propertyVariations: {
                    type: 'object',
                    description: 'Property name to value list, cycled across copies.'
                  },
                  targetParents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Parent path per copy, index 1 is the first copy.'
                  }
                }
              }
            },
            required: ['instancePath', 'count']
          },
          description: 'One duplication job per source instance.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['duplications']
    }
  },

  // === Calculated/Relative Properties ===
  // === Script Read/Write ===
  {
    name: 'get_script_source',
    category: 'read',
    description: 'Use to read a script\'s source with line numbers before editing it.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the script instance to read'
        },
        line_range: {
          type: 'string',
          description: '1-indexed inclusive lines: "100-200", "100-", "-200", or "42"'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'set_script_source',
    category: 'write',
    description: 'Use to overwrite a whole script when the rewrite is larger than a few targeted line edits.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the script instance to overwrite'
        },
        source: {
          type: 'string',
          description: 'Full replacement source; existing content is discarded'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'source']
    }
  },
  {
    name: 'edit_script_lines',
    category: 'write',
    description: 'Use to replace an exact snippet of script text with new text, leaving the rest untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the script instance to edit'
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find; must be unique unless line_range is set'
        },
        new_string: {
          type: 'string',
          description: 'Text that replaces old_string in the script'
        },
        line_range: {
          type: 'string',
          description: '1-indexed line where old_string starts, skips uniqueness check'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'old_string', 'new_string']
    }
  },
  {
    name: 'insert_script_lines',
    category: 'write',
    description: 'Use to add new lines to a script at a chosen point without touching existing lines.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the script instance to edit'
        },
        afterLine: {
          type: 'number',
          description: '1-indexed line to insert after; 0 inserts at the top'
        },
        newContent: {
          type: 'string',
          description: 'Text to insert, may span multiple lines'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'newContent']
    }
  },
  {
    name: 'delete_script_lines',
    category: 'write',
    description: 'Use to remove a contiguous block of lines from a script by line number.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the script instance to edit'
        },
        line_range: {
          type: 'string',
          description: '1-indexed inclusive "100-200" or "42"; no open ends'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'line_range']
    }
  },

  // === Attributes ===
  {
    name: 'set_attribute',
    category: 'write',
    description: 'Use to write a single named attribute onto an instance, creating or overwriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to write to.'
        },
        attributeName: {
          type: 'string',
          description: 'Attribute name to create or overwrite.'
        },
        attributeValue: {
          description: 'Primitive, or object with _type for Vector3/Color3/UDim2.'
        },
        valueType: {
          type: 'string',
          description: 'Type hint, string keeps true/false as literal text.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'attributeName', 'attributeValue']
    }
  },
  {
    name: 'get_attributes',
    category: 'read',
    description: 'Use to read every attribute and its value type from one instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to read.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'delete_attribute',
    category: 'write',
    description: 'Use to remove one attribute from an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to edit.'
        },
        attributeName: {
          type: 'string',
          description: 'Attribute to remove, absent names are not an error.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'attributeName']
    }
  },

  // === Tags ===
  {
    name: 'get_tags',
    category: 'read',
    description: 'Use to list the CollectionService tags currently on one instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to read.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'add_tag',
    category: 'write',
    description: 'Use to tag an instance so CollectionService driven code picks it up.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to tag.'
        },
        tagName: {
          type: 'string',
          description: 'Tag to add, exact and case sensitive.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'tagName']
    }
  },
  {
    name: 'remove_tag',
    category: 'write',
    description: 'Use to untag an instance so tag driven code stops handling it.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to untag.'
        },
        tagName: {
          type: 'string',
          description: 'Tag to remove, exact and case sensitive.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'tagName']
    }
  },
  {
    name: 'get_tagged',
    category: 'read',
    description: 'Use to find every instance in the place that carries a given tag.',
    inputSchema: {
      type: 'object',
      properties: {
        tagName: {
          type: 'string',
          description: 'Tag to look up, exact and case sensitive.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['tagName']
    }
  },

  // === Selection ===
  {
    name: 'selection',
    category: 'read',
    description: 'Use to read or replace the Studio selection, or to aim the edit-mode camera at an instance before a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'view'],
          description: 'Whether to read, replace, or frame the selected instances.'
        },
        paths: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Instance paths for set; empty array clears when mode is set.'
        },
        mode: {
          type: 'string',
          enum: ['set', 'add', 'remove'],
          default: 'set',
          description: 'How paths apply to what is already selected.'
        },
        path: {
          type: 'string',
          minLength: 1,
          description: 'Path of the BasePart or Model to frame for view.'
        },
        from: {
          type: 'number',
          description: 'Camera azimuth in degrees; 0 is +X, 90 is +Z.'
        },
        padding: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 10,
          default: 1,
          description: 'Distance scale from target; above 1 pulls the camera back.'
        },
        angleY: {
          type: 'number',
          minimum: -89,
          maximum: 89,
          description: 'Camera elevation in degrees; positive looks downward.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['action']
    }
  },

  // === Luau Execution ===
  {
    name: 'execute_luau',
    category: 'write',
    description: 'Use to run Luau in a plugin sandbox against the edit, server, or client DataModel with plugin permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau to run; print/warn and the return value are captured.'
        },
        target: {
          type: 'string',
          description: 'Which DataModel: edit (default), server, or client-N.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_server_runtime',
    category: 'write',
    description: 'Use during a playtest to run Luau on the server inside the game\'s own script VM and require cache.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau to run; use return to send a value back.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_client_runtime',
    category: 'write',
    description: 'Use during a playtest to run Luau on a client inside the game\'s own LocalScript VM and require cache.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau to run; use return to send a value back.'
        },
        target: {
          type: 'string',
          description: 'Which client peer, client-1 by default.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['code']
    }
  },

  // === Script Search ===
  {
    name: 'grep_scripts',
    category: 'read',
    description: 'Use to find which scripts contain given text or a Lua pattern, with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text to find, or a Lua pattern when usePattern is true'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Literal-search case sensitivity, default false'
        },
        usePattern: {
          type: 'boolean',
          description: 'Treat pattern as a Lua pattern (not PCRE), default false'
        },
        contextLines: {
          type: 'number',
          description: 'Lines of context shown around each match, default 0'
        },
        maxResults: {
          type: 'number',
          description: 'Total match cap before search stops, default 100'
        },
        maxResultsPerScript: {
          type: 'number',
          description: 'Cap on matches reported per script'
        },
        filesOnly: {
          type: 'boolean',
          description: 'Return only matching script paths, default false'
        },
        path: {
          type: 'string',
          description: 'Subtree to limit the search to, defaults to whole place'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Restrict to one script class, default all classes'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['pattern']
    }
  },

  // === Studio Instance Management ===
  {
    name: 'manage_instance',
    category: 'write',
    description: 'Use to launch, close, or inspect Studio processes, or to list past versions of a published place.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'authorize', 'complete', 'close', 'status', 'list_place_versions'],
          description: 'Which lifecycle step to run on a Studio process.'
        },
        source: {
          type: 'string',
          enum: ['baseplate', 'local_file', 'published_place', 'place_revision'],
          description: 'What the launched window opens; only launch uses it.'
        },
        local_place_file: {
          type: 'string',
          description: 'Path to a .rbxl or .rbxlx file for a local source.'
        },
        place_id: {
          type: 'number',
          description: 'Published place ID; never pass it for local or blank places.'
        },
        place_version: {
          type: 'number',
          description: 'Version number of the revision to open.'
        },
        require_process_identity: {
          type: 'boolean',
          description: 'Capture exact PID and keep the new process suspended.'
        },
        wait_for_connection: {
          type: 'boolean',
          description: 'Block until the plugin connects, default true.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Milliseconds to wait for plugin connection, default 120000.'
        },
        studio_executable: {
          type: 'string',
          description: 'Exact Studio executable path instead of auto-discovery.'
        },
        studio_working_directory: {
          type: 'string',
          description: 'Working directory, isolates per-launch plugin folders.'
        },
        process_environment: {
          type: 'object',
          description: 'Env patch used only while creating the process.',
          properties: {
            set: {
              type: 'object',
              description: 'Variables to set for the Studio process.',
              propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$'
              },
              additionalProperties: {
                type: 'string'
              }
            },
            remove: {
              type: 'array',
              description: 'Variable names to drop from the process environment.',
              items: {
                type: 'string',
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$'
              }
            }
          },
          additionalProperties: false
        },
        max_page_size: {
          type: 'number',
          description: 'Versions per page, default 10, clamped to 1-50.'
        },
        page_token: {
          type: 'string',
          description: 'Pagination token from a prior version listing.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected instance to inspect or close, not with launch_id.'
        },
        launch_id: {
          type: 'string',
          description: 'ID from launch, usable before the plugin connects.'
        }
      },
      required: ['action']
    }
  },

  // === Playtest ===
  {
    name: 'solo_playtest',
    category: 'write',
    description: 'Use to start, stop, or check a single-player playtest before running runtime evaluation or profiling.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'Which lifecycle step to perform.'
        },
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Play spawns a character, run starts the server only.'
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait; defaults are 60 for start, 15 for stop.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'set_network_profile',
    category: 'write',
    description: 'Use set_network_profile to give playtest clients simulated latency, jitter, or packet loss while testing.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['great', 'good', 'poor', 'custom'],
          description: 'Named condition preset; custom applies only your overrides.'
        },
        target: {
          type: 'string',
          description: 'Client peer such as "client-1" (default), or "all-clients".'
        },
        overrides: {
          type: 'object',
          additionalProperties: false,
          properties: {
            InboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Server to client minimum latency, milliseconds.'
            },
            OutboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Client to server minimum latency, milliseconds.'
            },
            InboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Server to client latency jitter, milliseconds.'
            },
            OutboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Client to server latency jitter, milliseconds.'
            },
            InboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Server to client packet loss percent, engine max 0.5.'
            },
            OutboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Client to server packet loss percent, engine max 0.5.'
            }
          },
          description: 'Exact NetworkSettings values replacing preset fields.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['profile']
    }
  },
  {
    name: 'get_simulation_state',
    category: 'read',
    description: 'Use get_simulation_state to check current simulated network and device settings when you suspect stale state.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['network', 'deviceSimulator', 'both'],
          description: 'Which simulation subsystem to report (default both).'
        },
        target: {
          type: 'string',
          description: 'Scope: edit-and-clients (default), edit, all-clients, client-N.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'reset_simulation_state',
    category: 'write',
    description: 'Use reset_simulation_state to clear simulated network and device settings back to a clean baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Scope: edit-and-clients (default), edit, all-clients, client-N.'
        },
        network: {
          type: 'boolean',
          description: 'Zero the six simulated network fields (default true).'
        },
        deviceSimulator: {
          type: 'boolean',
          description: 'Stop any active device simulation (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'get_device_simulator_state',
    category: 'read',
    description: 'Use get_device_simulator_state to see the active simulated device and list built-in device presets.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '"edit" (default) or a playtest client like "client-1".'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in preset ID to report full details for.'
        },
        includeDeviceList: {
          type: 'boolean',
          description: 'Include the built-in device preset list (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'set_device_simulator',
    category: 'write',
    description: 'Use set_device_simulator to emulate a phone or tablet viewport in Studio, or to stop simulating one.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '"edit" (default), a "client-N" peer, or "all-clients".'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in device preset ID; list the presets first.'
        },
        orientation: {
          type: 'string',
          description: 'ScreenOrientation name such as "LandscapeRight".'
        },
        resolution: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: {
              type: 'number',
              description: 'Viewport width in pixels.'
            },
            height: {
              type: 'number',
              description: 'Viewport height in pixels.'
            }
          },
          required: ['width', 'height'],
          description: 'Viewport size override applied after the preset.'
        },
        pixelDensity: {
          type: 'number',
          description: 'Positive pixel density applied after the preset.'
        },
        scalingMode: {
          type: 'string',
          description: 'DeviceSimulatorScalingMode name like "ScaleToPhysicalSize".'
        },
        stopSimulation: {
          type: 'boolean',
          description: 'Stop simulating; pass no other setters alongside it.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'capture_device_matrix',
    category: 'write',
    description: 'Use capture_device_matrix to screenshot one scene across several simulated devices in a single pass.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          maxItems: 6,
          description: 'Ordered device setups, each captured in turn, at most 6.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: {
                type: 'string',
                description: 'Label recorded in this shot\'s metadata.'
              },
              deviceId: {
                type: 'string',
                description: 'Built-in device preset ID for this entry.'
              },
              orientation: {
                type: 'string',
                description: 'ScreenOrientation name for this entry.'
              },
              resolution: {
                type: 'object',
                additionalProperties: false,
                description: 'Viewport size override for this entry.',
                properties: {
                  width: {
                    type: 'number',
                    description: 'Viewport width in pixels.'
                  },
                  height: {
                    type: 'number',
                    description: 'Viewport height in pixels.'
                  }
                },
                required: ['width', 'height']
              },
              pixelDensity: {
                type: 'number',
                description: 'Positive pixel density override for this entry.'
              },
              scalingMode: {
                type: 'string',
                description: 'DeviceSimulatorScalingMode name for this entry.'
              }
            }
          }
        },
        target: {
          type: 'string',
          description: '"edit" (default) or a playtest client like "client-1".'
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format; jpeg is compact, png is lossless but large.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92), ignored for png.'
        },
        settleSeconds: {
          type: 'number',
          description: 'Wait after applying each entry, seconds (default 0.3).'
        },
        restoreAfter: {
          type: 'boolean',
          description: 'Restore the prior simulator state after (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['entries']
    }
  },
  {
    name: 'multiplayer_playtest',
    category: 'write',
    description: 'Use to start, inspect, grow, or end a multiplayer playtest with multiple simulated client peers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'add_players', 'leave_client', 'end'],
          description: 'Lifecycle step to run on the multiplayer session.'
        },
        numPlayers: {
          type: 'number',
          description: 'Client players to launch or add, 1-8; start/add_players only.'
        },
        target: {
          type: 'string',
          description: 'Client to remove for leave_client, defaults to client-1.'
        },
        testArgs: {
          description: 'JSON table given to StudioTestService:GetTestArgs() at start.'
        },
        value: {
          description: 'Optional value handed to the end teardown.'
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait for peers or completion, defaults to 30.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'get_runtime_logs',
    category: 'read',
    description: 'Use to read recent script output and errors captured from Studio edit, server, and client peers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Buffer to read: edit, server, client-N, or all (default).'
        },
        since: {
          type: 'number',
          description: 'Return entries with seq above this; pass back nextSince.'
        },
        tail: {
          type: 'number',
          description: 'Keep only the last N entries, applied after since and filter.'
        },
        filter: {
          type: 'string',
          description: 'Literal substring matched on message, no pattern syntax.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'capture_script_profiler',
    category: 'read',
    description: 'Use to find hot Luau functions on a running server or client peer during a reproducible workload.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Runtime peer to profile: server (default) or client-N.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 15000,
          description: 'Sample length in milliseconds, default 1000, clamped 100-15000.'
        },
        frequency: {
          type: 'number',
          default: 1000,
          minimum: 1,
          maximum: 10000,
          description: 'Sampling rate in samples per second, default 1000.'
        },
        max_functions: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Rows of functions and labels returned, default 20, max 100.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Drop functions under this total microseconds, default 0.'
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive substring on function name or source.'
        },
        include_native: {
          type: 'boolean',
          description: 'Include native engine frames, default false.'
        },
        include_plugin: {
          type: 'boolean',
          description: 'Include plugin frames, default false.'
        },
        output_path: {
          type: 'string',
          description: 'Local file for raw profiler JSON instead of inline output.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'capture_micro_profiler',
    category: 'read',
    description: 'Use to see where frame time goes across scripts, physics, render, network, and engine jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Runtime peer to profile: server (default) or client-N.'
        },
        action: {
          type: 'string',
          enum: ['capture', 'arm', 'collect', 'cancel', 'analyze'],
          default: 'capture',
          description: 'What this call does in the capture lifecycle.'
        },
        capture_id: {
          type: 'string',
          description: 'Id from a prior capture or arm, needed to poll or re-analyze.'
        },
        trigger: {
          type: 'object',
          description: 'Trigger condition for an armed capture, pick one kind.',
          properties: {
            kind: {
              type: 'string',
              enum: ['frame_time', 'attribute', 'log'],
              description: 'Which condition fires the armed capture.'
            },
            threshold_ms: {
              type: 'number',
              minimum: 1,
              maximum: 10000,
              description: 'Fire on the first complete frame at or above this many ms.'
            },
            instance: {
              type: 'string',
              description: 'Path to the instance holding the watched attribute.'
            },
            name: {
              type: 'string',
              description: 'Attribute name to watch on that instance.'
            },
            value: {
              description: 'Exact value to wait for, omit for any truthy value.'
            },
            substring: {
              type: 'string',
              description: 'Plain substring matched against log output, not a pattern.'
            }
          }
        },
        arm_timeout_ms: {
          type: 'number',
          default: 60000,
          minimum: 1000,
          maximum: 300000,
          description: 'Wait this long in ms for the trigger, default 60000.'
        },
        frames_before: {
          type: 'number',
          default: 8,
          minimum: 0,
          maximum: 200,
          description: 'Frames kept before the trigger frame, default 8.'
        },
        post_trigger_frames: {
          type: 'number',
          default: 30,
          minimum: 0,
          maximum: 200,
          description: 'Frames kept after the trigger frame, default 30.'
        },
        max_frame_breakdowns: {
          type: 'number',
          default: 3,
          minimum: 0,
          maximum: 10,
          description: 'Longest frames given their own breakdown, default 3, 0 omits.'
        },
        include_sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['top_groups_by_exclusive', 'top_timers_by_exclusive', 'top_threads', 'top_call_edges', 'all']
          },
          description: 'Extra sections to keep inline, or all to keep everything.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 5000,
          description: 'Capture length in ms, default 1000, clamped 100-5000.'
        },
        focus: {
          type: 'string',
          enum: ['all', 'script', 'physics', 'render', 'network', 'jobs'],
          default: 'all',
          description: 'Narrow attribution to one subsystem after a broad pass.'
        },
        filter: {
          type: 'string',
          description: 'Case-insensitive substring on timer name and group.'
        },
        max_timers: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Rows of top timers to return, default 20.'
        },
        max_groups: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Rows of top groups to return, default 20.'
        },
        max_timers_per_group: {
          type: 'number',
          default: 5,
          minimum: 0,
          maximum: 20,
          description: 'Nested timers inside each group row, default 5, 0 omits.'
        },
        max_related_timers: {
          type: 'number',
          default: 3,
          minimum: 0,
          maximum: 10,
          description: 'Parent, child, and thread rows per timer, default 3.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Drop timers under this inclusive microseconds, default 0.'
        },
        include_idle: {
          type: 'boolean',
          description: 'Include Sleep and idle timers, default false.'
        },
        include_gpu: {
          type: 'boolean',
          description: 'Include GPU thread events when exposed, default false.'
        },
        max_events: {
          type: 'number',
          default: 250000,
          minimum: 10000,
          maximum: 1000000,
          description: 'Cap on profiler log events walked, default 250000.'
        },
        frame_window: {
          type: 'number',
          default: 240,
          minimum: 1,
          maximum: 2000,
          description: 'Analyze only the last N captured frames, default 240.'
        },
        output_path: {
          type: 'string',
          description: 'Local file for the raw snapshot bytes.'
        },
        summary_output_path: {
          type: 'string',
          description: 'Local file for the full untrimmed summary JSON.'
        },
        baseline_path: {
          type: 'string',
          description: 'Local path to a saved summary JSON to diff against.'
        },
        baseline: {
          type: 'object',
          description: 'Inline prior summary to diff against, large ones use a path.'
        },
        baseline_label: {
          type: 'string',
          description: 'Name for the baseline side of the comparison.'
        },
        current_label: {
          type: 'string',
          description: 'Name for the current side of the comparison.'
        },
        max_comparison_rows: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Delta rows per comparison section, default 20.'
        },
        include_comparison_index: {
          type: 'boolean',
          description: 'Inline the compact comparison index, default false.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'breakpoints',
    category: 'write',
    description: 'Use breakpoints to log or pause at a script line when the user asks to debug inside Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'remove', 'clear', 'list'],
          description: 'Lifecycle step; set and remove need script_path and line.'
        },
        clear_all: {
          type: 'boolean',
          description: 'For clear: true also wipes user-made stops, default false.'
        },
        script_path: {
          type: 'string',
          description: 'Canonical path to the script, required for set and remove.'
        },
        line: {
          type: 'number',
          description: '1-based line number, required for set and remove.'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the breakpoint starts enabled, default true.'
        },
        condition: {
          type: 'string',
          description: 'Luau expression that must be true for the stop to apply.'
        },
        log_message: {
          type: 'string',
          description: 'Luau expression list to log, quote literal text as strings.'
        },
        continue_execution: {
          type: 'boolean',
          description: 'Log without pausing, default true when log_message is set.'
        },
        target: {
          type: 'string',
          description: 'Peer to target: edit (default), server, or client-N.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['action']
    }
  },

  // === Multi-Instance ===
  {
    name: 'get_connected_instances',
    category: 'read',
    description: 'Use to list connected plugin peers and their roles when targeting a specific edit, server, or client.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_studio_sessions',
    category: 'read',
    description: 'Use to see which Studio places are connected, their instance IDs, and which one is pinned for routing.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'set_active_session',
    category: 'write',
    description: 'Use to pin one connected Studio place as the default routing target for calls that omit instance_id.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: {
          type: 'string',
          description: 'One instance to pin, for a place open in two windows.'
        },
        placeId: {
          type: 'number',
          description: 'Numeric place ID of the session to pin.'
        },
        placeName: {
          type: 'string',
          description: 'Place name, case-insensitive, must match one session.'
        },
        clear: {
          type: 'boolean',
          description: 'True unpins and restores default routing.'
        }
      }
    }
  },

  // === Asset Tools ===
  {
    name: 'search_assets',
    category: 'read',
    description: 'Use to discover public Creator Store assets by keyword and type without Roblox credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: {
          type: 'string',
          enum: ['Audio', 'Model', 'Decal', 'Image', 'Particle', 'VFX', 'Plugin', 'MeshPart', 'Video', 'FontFamily'],
          description: 'Image searches Decals; Particle and VFX search effect Models.'
        },
        query: {
          type: 'string',
          description: 'Search keywords, optional when browsing a whole type.'
        },
        maxResults: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Rows to return (default 25, cap 100).'
        },
        sortBy: {
          type: 'string',
          enum: ['Relevance', 'Trending', 'Top', 'AudioDuration', 'CreateTime', 'UpdatedTime', 'Ratings'],
          description: 'Result ordering, defaults to Relevance.'
        },
        robloxCreatedOnly: {
          type: 'boolean',
          default: false,
          description: 'Limit to Roblox-made assets (default false).'
        }
      },
      required: ['assetType']
    }
  },
  {
    name: 'get_asset_details',
    category: 'read',
    description: 'Use for full catalog metadata on one shortlisted asset ID after a Creator Store search.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox catalog asset ID to look up.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'get_asset_thumbnail',
    category: 'read',
    description: 'Use to view an asset visually as a base64 PNG before shortlisting or inserting it.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox catalog asset ID to render.'
        },
        size: {
          type: 'string',
          enum: ['150x150', '420x420', '768x432'],
          description: 'Image dimensions in pixels, default 420x420.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'insert_asset',
    category: 'write',
    description: 'Use to place a Creator Store asset into the live place after you have vetted it.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox catalog asset ID to insert.'
        },
        parentPath: {
          type: 'string',
          description: 'Canonical parent path, defaults to game.Workspace.'
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'World X in studs.' },
            y: { type: 'number', description: 'World Y in studs.' },
            z: { type: 'number', description: 'World Z in studs.' }
          },
          description: 'World position to place the asset when set.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'generate_model',
    category: 'write',
    description: 'Use to create a new 3D model from a text prompt or reference image when no catalog asset fits.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to generate, required unless an image is given.'
        },
        image_path: {
          type: 'string',
          description: 'Local PNG reference, uploaded to Roblox first.'
        },
        image_base64: {
          type: 'string',
          maxLength: MAX_PNG_BASE64_CHARACTERS,
          description: 'Inline PNG reference bytes, uploaded to Roblox first.'
        },
        image_mime_type: {
          type: 'string',
          enum: ['image/png'],
          description: 'Format of image_base64, required when it is set.'
        },
        image_asset_id: {
          type: 'number',
          description: 'Existing Roblox image asset to reuse as reference.'
        },
        schema: {
          type: 'string',
          enum: ['Body1', 'Car5'],
          default: 'Body1',
          description: 'Built-in part layout, default Body1 (one mesh).'
        },
        schema_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom part group names, conflicts with schema.'
        },
        name: {
          type: 'string',
          description: 'Name for the staged Model under ServerStorage.'
        },
        size: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Target X extent in studs.' },
            y: { type: 'number', description: 'Target Y extent in studs.' },
            z: { type: 'number', description: 'Target Z extent in studs.' }
          },
          description: 'Rough target size, generation may not match it exactly.'
        },
        max_triangles: {
          type: 'number',
          minimum: 1,
          description: 'Triangle budget, lower gives more faceted results.'
        },
        generate_textures: {
          type: 'boolean',
          description: 'Whether to texture the model, defaults to true.'
        },
        timeout_ms: {
          type: 'number',
          minimum: 1,
          maximum: 300000,
          default: 120000,
          description: 'Bridge wait in milliseconds, default 120000.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'preview_asset',
    category: 'read',
    description: 'Use to inspect a Creator Store asset\'s hierarchy and audio safely before you insert it.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'Roblox catalog asset ID to inspect.'
        },
        includeProperties: {
          type: 'boolean',
          default: false,
          description: 'Include node properties in the tree (default false).'
        },
        maxDepth: {
          type: 'number',
          default: 4,
          description: 'Display tree depth, default 4, display caps at 100 nodes.'
        },
        includeAudio: {
          type: 'boolean',
          default: true,
          description: 'Return inline audio clips (default true).'
        },
        maxAudioPreviews: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          default: 3,
          description: 'Unique sounds to return as audio (default 3, cap 5).'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'upload_asset',
    category: 'write',
    description: 'Use to publish a local audio, image, model, animation, or video file to Roblox as an asset.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file on disk.'
        },
        assetType: {
          type: 'string',
          enum: ['Audio', 'Decal', 'Model', 'Animation', 'Video'],
          description: 'Kind of asset, must match the file format.'
        },
        displayName: {
          type: 'string',
          description: 'Catalog display name, max 50 characters.'
        },
        description: {
          type: 'string',
          description: 'Catalog description, defaults to empty.'
        },
        userId: {
          type: 'string',
          description: 'Creator user ID, overrides ROBLOX_CREATOR_USER_ID.'
        },
        groupId: {
          type: 'string',
          description: 'Creator group ID, wins over userId when both are set.'
        }
      },
      required: ['filePath', 'assetType', 'displayName']
    }
  },
  {
    name: 'capture_screenshot',
    category: 'read',
    description: 'Use capture_screenshot to see the Studio viewport, in edit mode or during a running playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'jpeg is compact; png is lossless, best for dense text or UI.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92), ignored for png.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
    }
  },

  // === Input Simulation ===
  {
    name: 'simulate_mouse_input',
    category: 'write',
    description: 'Use simulate_mouse_input during a playtest to click UI buttons, objects, or aim at a viewport pixel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'mouseDown', 'mouseUp'],
          description: 'click is a down, brief pause, then up.'
        },
        x: {
          type: 'number',
          description: 'Viewport pixel X, top-left origin, as seen in a screenshot.'
        },
        y: {
          type: 'number',
          description: 'Viewport pixel Y, top-left origin, as seen in a screenshot.'
        },
        button: {
          type: 'string',
          enum: ['Left', 'Right', 'Middle'],
          description: 'Mouse button (default Left).'
        },
        target: {
          type: 'string',
          description: 'Peer to drive; defaults to the running playtest client.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['action', 'x', 'y']
    }
  },
  {
    name: 'simulate_keyboard_input',
    category: 'write',
    description: 'Use simulate_keyboard_input during a playtest to walk, jump, fire key actions, or type text.',
    inputSchema: {
      type: 'object',
      properties: {
        keyCode: {
          type: 'string',
          description: 'Enum.KeyCode name such as "W" or "Space"; omit with text.'
        },
        action: {
          type: 'string',
          enum: ['press', 'release', 'tap'],
          description: 'tap does both halves; press and release do one each.'
        },
        duration: {
          type: 'number',
          description: 'Hold time in seconds for tap (default 0.1).'
        },
        text: {
          type: 'string',
          description: 'Type into the focused TextBox; overrides keyCode/action.'
        },
        target: {
          type: 'string',
          description: 'Peer to drive; defaults to the running playtest client.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },

  // === Instance Operations ===
  {
    name: 'clone_object',
    category: 'write',
    description: 'Use to copy an existing instance, with all of its descendants, under a different parent.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to copy'
        },
        targetParentPath: {
          type: 'string',
          description: 'Canonical path of the parent that receives the copy'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'targetParentPath']
    }
  },
  // === Descendants & Comparison ===
  {
    name: 'get_descendants',
    category: 'read',
    description: 'Use to walk an entire subtree in one call instead of paging through children level by level.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the subtree root.'
        },
        maxDepth: {
          type: 'number',
          description: 'Recursion depth limit, default 10.'
        },
        classFilter: {
          type: 'string',
          description: 'Class to keep, matched with IsA so subclasses count.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'compare_instances',
    category: 'read',
    description: 'Use to diff the properties of two instances when a copy behaves differently from the original.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePathA: {
          type: 'string',
          description: 'Canonical DataModel path to the first instance.'
        },
        instancePathB: {
          type: 'string',
          description: 'Canonical DataModel path to the second instance.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePathA', 'instancePathB']
    }
  },
  // === Bulk Attributes ===
  {
    name: 'bulk_set_attributes',
    category: 'write',
    description: 'Use to set many attributes on one instance in a single call.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to write to.'
        },
        attributes: {
          type: 'object',
          description: 'Name to value map, datatypes need an inline _type tag.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instancePath', 'attributes']
    }
  },

  // === Per-peer memory breakdown ===
  {
    name: 'get_memory_breakdown',
    category: 'read',
    description: 'Use to see how much memory each category is using on the connected peers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Peer to read: edit, server, client-N, or all (default).'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'DeveloperMemoryTag whitelist, omit to return every tag.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },
  {
    name: 'get_scene_analysis',
    category: 'read',
    description: 'Use to attribute memory and triangle counts to the instances, scripts, and assets in a place.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'instance_composition', 'script_memory', 'unparented_instances', 'triangle_composition', 'animation_memory', 'audio_memory'],
          description: 'Which attribution report to read, defaults to all.'
        },
        target: {
          type: 'string',
          description: 'Peer to read: edit, server, client-N, or all (default).'
        },
        topN: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Flattened entries per report, default 10, clamped 1-100.'
        },
        raw: {
          type: 'boolean',
          description: 'Also include the full nested analysis tree, default false.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      }
    }
  },

  // === SerializationService round-trip ===
  {
    name: 'export_rbxm',
    category: 'read',
    description: 'Use to save instances from the place to a .rbxm file on disk for backup or reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical paths of the instances to serialize.'
        },
        output_path: {
          type: 'string',
          description: 'Absolute path of the .rbxm file to write.'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to read, default edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['instance_paths', 'output_path']
    }
  },
  {
    name: 'import_rbxm',
    category: 'write',
    description: 'Use to load a .rbxm from disk, a URL, or inline bytes into the place under a chosen parent.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: 'Model bytes source, supply exactly one field.',
          properties: {
            path: { type: 'string', description: 'Local .rbxm/.rbxmx path read by the server process.' },
            url: { type: 'string', description: 'http(s) URL fetched by the server, capped at 50 MiB.' },
            base64: { type: 'string', description: 'Raw model bytes inline, base64-encoded.' }
          },
          oneOf: [
            { required: ['path'] },
            { required: ['url'] },
            { required: ['base64'] }
          ]
        },
        parent_path: {
          type: 'string',
          description: 'Canonical path to parent the imported instances under.'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to import into, default edit.'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['source', 'parent_path']
    }
  },

  // === Find and Replace ===
  {
    name: 'find_and_replace_in_scripts',
    category: 'write',
    description: 'Use to apply one text or pattern replacement across many scripts at once.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text to find, or a Lua pattern when usePattern is true'
        },
        replacement: {
          type: 'string',
          description: 'Replacement text; %1, %2 captures work in pattern mode'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive matching, default false'
        },
        usePattern: {
          type: 'boolean',
          description: 'Treat pattern as a Lua pattern, default false'
        },
        path: {
          type: 'string',
          description: 'Subtree to limit scope to, defaults to whole place'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Restrict to one script class, default all classes'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview matches without writing, default false'
        },
        maxReplacements: {
          type: 'number',
          description: 'Safety cap on total replacements, default 1000'
        },
        instance_id: {
          type: 'string',
          description: 'Target Studio place; omit when only one is connected.'
        }
      },
      required: ['pattern', 'replacement']
    }
  },

  // === Installed Studio Skills ===
  {
    name: 'get_roblox_skills',
    category: 'read',
    description: 'Use to read Roblox-authored guidance shipped with the Studio Assistant bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'Choose discovery of names or retrieval of one doc.'
        },
        name: {
          type: 'string',
          description: 'Skill name from a list call, canonical or source name.'
        }
      },
      required: ['action']
    }
  },

  // === Documentation ===
  {
    name: 'get_roblox_docs',
    category: 'read',
    description: 'Use before writing code against any engine class, enum, datatype, or Luau library you are unsure of.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact PascalCase API name, such as ProximityPrompt.'
        },
        doc_type: {
          type: 'string',
          enum: ['classes', 'enums', 'datatypes', 'libraries', 'globals'],
          description: 'Which doc category the name lives in, default classes.'
        },
        section: {
          type: 'string',
          description: 'One \'##\' section to return instead of the full page.'
        }
      },
      required: ['name']
    }
  },
];

export const DEPRECATED_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Deprecated Playtest API ===
  {
    name: 'start_playtest',
    category: 'write',
    description: 'Deprecated. Use solo_playtest with action="start" instead. Starts a simple single-player Studio playtest in play or run mode.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Play mode'
        },
        numPlayers: {
          type: 'number',
          description: 'Deprecated and rejected. Use multiplayer_playtest action="start" for multi-client testing.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'stop_playtest',
    category: 'write',
    description: 'Deprecated. Use solo_playtest with action="stop" instead. Stops a single-player Studio playtest and waits for runtime peers to disconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_start',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="start" instead. Starts a StudioTestService multiplayer test only when force=true acknowledges that MCP cannot stop it and the test windows must be closed manually.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of client players to start (1-8).'
        },
        testArgs: {
          description: 'JSON-compatible table passed to StudioTestService:GetTestArgs() on server and clients.'
        },
        force: {
          type: 'boolean',
          description: 'Required. Pass true only if you understand StudioTestService:EndTest is broken in this flow and you will manually close the multiplayer test windows.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for server + clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['numPlayers', 'force']
    }
  },
  {
    name: 'multiplayer_test_state',
    category: 'read',
    description: 'Deprecated. Use multiplayer_playtest with action="status" instead. Gets the active multiplayer StudioTestService state.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to inspect. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_add_players',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="add_players" instead. Adds client players to a running StudioTestService multiplayer test.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of additional client players to add (1-8).'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for new clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['numPlayers']
    }
  },
  {
    name: 'multiplayer_test_leave_client',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="leave_client" instead. Disconnects a specific client from a running StudioTestService multiplayer test.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Client target to leave: "client-1" (default), "client-2", etc.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for the client peer to disconnect (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_end',
    category: 'write',
    description: 'Deprecated. Multiplayer StudioTestService stop/end is disabled for now because StudioTestService:EndTest is broken in this flow. This tool returns a disabled error and does not call EndTest.',
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          description: 'Ignored while multiplayer stop/end is disabled.'
        },
        timeout: {
          type: 'number',
          description: 'Ignored while multiplayer stop/end is disabled.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
];

export const getReadOnlyTools = () => TOOL_DEFINITIONS.filter(t => t.category === 'read');
export const getAllTools = () => [...TOOL_DEFINITIONS];
export const getReadOnlyCallableTools = () => [...TOOL_DEFINITIONS, ...DEPRECATED_TOOL_DEFINITIONS].filter(t => t.category === 'read');
export const getAllCallableTools = () => [...TOOL_DEFINITIONS, ...DEPRECATED_TOOL_DEFINITIONS];
