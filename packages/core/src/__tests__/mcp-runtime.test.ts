import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Server as HttpServer } from 'node:http';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer, TOOL_HANDLERS } from '../http-server.js';
import {
  createToolServer,
  normalizeToolResult,
  publicToolDefinition,
  serverInstructions,
} from '../mcp-runtime.js';
import { getReadOnlyTools, TOOL_DEFINITIONS } from '../tools/definitions.js';
import { RobloxStudioTools } from '../tools/index.js';

type JsonObject = Record<string, unknown>;

// Answers the next plugin request queued for `role` while a tool call is in flight,
// the way the Studio plugin's poll loop would. Returns the request it answered.
async function answerPending(
  bridge: BridgeService,
  role: string,
  respond: (request: { endpoint: string; data: any }) => unknown,
): Promise<{ endpoint: string; data: any }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = bridge.getPendingRequest('place:test', role);
    if (pending) {
      bridge.resolveRequest(pending.requestId, respond(pending.request));
      return pending.request;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for a ${role} plugin request`);
}

// A connected in-memory client/server pair whose tools are the real RobloxStudioTools
// dispatched through the real TOOL_HANDLERS, so results have their production shape.
async function connectedTools(toolNames: string[], tools: RobloxStudioTools) {
  const definitions = TOOL_DEFINITIONS.filter((tool) => toolNames.includes(tool.name));
  const server = createToolServer({
    config: { name: 'test-server', version: '3.0.0', tools: definitions },
    getTools: () => tools,
    era: 'modern',
    invoke: (target, name, args) => TOOL_HANDLERS[name](target, args),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { client, close };
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectPropertySchemas(
  schema: unknown,
  path = 'input',
  seen = new Set<object>(),
): Array<{ path: string; schema: JsonObject }> {
  if (!isJsonObject(schema) || seen.has(schema)) return [];
  seen.add(schema);

  const found: Array<{ path: string; schema: JsonObject }> = [];
  if (isJsonObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (!isJsonObject(propertySchema)) continue;
      const propertyPath = `${path}.${name}`;
      found.push({ path: propertyPath, schema: propertySchema });
      found.push(...collectPropertySchemas(propertySchema, propertyPath, seen));
    }
  }

  for (const keyword of ['items', 'additionalProperties'] as const) {
    if (isJsonObject(schema[keyword])) {
      found.push(...collectPropertySchemas(schema[keyword], `${path}[]`, seen));
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      found.push(...collectPropertySchemas(branch, path, seen));
    }
  }
  return found;
}

describe('MCP v2 tool runtime', () => {
  test('projects JSON once for modern clients and preserves media', () => {
    const result = normalizeToolResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            value: 42,
            pluginSessionId: 'internal-session',
            diagnostics: { elapsed: 10 },
          }),
        },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    }, 'modern');

    expect(result.structuredContent).toEqual({ success: true, value: 42 });
    expect(result.content).toEqual([
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
  });

  test('keeps one JSON text projection for legacy clients', () => {
    const result = normalizeToolResult({
      content: [{ type: 'text', text: JSON.stringify({ value: 42 }) }],
    }, 'legacy');

    expect(result.structuredContent).toEqual({ value: 42 });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ value: 42 }) },
    ]);
  });

  test('synthesizes structuredContent for schema-backed results without a JSON object', () => {
    const prose = normalizeToolResult({
      content: [
        { type: 'text', text: 'Screenshot 10x10px.' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' },
      ],
    }, 'modern', true);
    expect(prose.structuredContent).toEqual({ message: 'Screenshot 10x10px.' });
    expect(prose.content).toHaveLength(2);

    const mediaOnly = normalizeToolResult({
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
    }, 'legacy', true);
    expect(mediaOnly.structuredContent).toEqual({});
    expect(mediaOnly.content).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);

    // Markdown tools have no output schema, and error results are exempt from validation.
    expect(normalizeToolResult({ content: [{ type: 'text', text: '# Docs' }] }, 'modern').structuredContent)
      .toBeUndefined();
    const failed = normalizeToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }, 'modern', true);
    expect(failed.structuredContent).toBeUndefined();
    expect(failed.isError).toBe(true);
  });

  test('keeps the catalog within the 3.0 token budget', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const names = new Set(catalog.map((tool) => tool.name));
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    const serialized = JSON.stringify(catalog);
    const inspectorCatalog = getReadOnlyTools().map(publicToolDefinition);

    // This fork keeps tools upstream 3.0 dropped, so its catalog ceiling is higher than
    // upstream's 43,000, but the per-description budgets below are upstream's exactly.
    expect(catalog).toHaveLength(74);
    expect(serialized.length).toBeLessThanOrEqual(72_000);
    expect(catalog.every((tool) => tool.description.length <= 120)).toBe(true);
    // get_roblox_docs returns Markdown, so it is the one tool without a JSON output schema.
    expect(catalog.filter((tool) => tool.outputSchema)).toHaveLength(catalog.length - 1);
    expect(byName.get('get_roblox_docs')?.outputSchema).toBeUndefined();
    expect(JSON.stringify(inspectorCatalog).length).toBeLessThanOrEqual(33_000);
    expect(byName.get('selection')?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
    });
    // Media tools advertise the object schema too, so their results must carry a
    // structured object next to the image (covered by the transport tests below).
    for (const mediaTool of ['capture_screenshot', 'get_asset_thumbnail', 'capture_device_matrix']) {
      expect(byName.get(mediaTool)?.outputSchema).toEqual({ type: 'object', additionalProperties: true });
    }

    // Only the deprecated playtest aliases stay out of the advertised catalog here;
    // the rest of upstream's 3.0 cull is deliberately still exposed by this fork.
    for (const removed of [
      'start_playtest',
      'stop_playtest',
      'multiplayer_test_start',
      'multiplayer_test_state',
      'multiplayer_test_add_players',
      'multiplayer_test_leave_client',
      'multiplayer_test_end',
]) {
      // Hidden from the advertised catalog, but still routed for existing integrations.
      expect(names.has(removed)).toBe(false);
      expect(TOOL_HANDLERS[removed]).toBeDefined();
    }

    expect(byName.get('set_properties')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('upload_asset')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get('export_rbxm')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('capture_script_profiler')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    for (const openWorldTool of [
      'execute_luau',
      'eval_server_runtime',
      'eval_client_runtime',
      'insert_asset',
    ]) {
      expect(byName.get(openWorldTool)?.annotations.openWorldHint).toBe(true);
    }
    expect(byName.get('edit_script_lines')?.annotations.idempotentHint).toBe(false);
    expect(byName.get('find_and_replace_in_scripts')?.annotations.idempotentHint).toBe(false);
    expect(byName.get('selection')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test('keeps selection, argument, and behavior metadata in their contract layers', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const toolNames = catalog.map((tool) => tool.name);
    const annotationKeys = [
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
      'readOnlyHint',
    ];

    for (const tool of catalog) {
      // Upstream's advertisement contract, adopted in full: one "Use ...." sentence that
      // never leaks another tool's name, so cross-tool guidance lives in the server
      // instructions and the tool guide instead of in every description.
      expect(tool.description).toMatch(/^Use .+\.$/);
      expect(tool.description.match(/\.(?:\s|$)/g)).toHaveLength(1);
      expect(tool.description.length).toBeLessThanOrEqual(120);
      expect(tool.description).not.toContain('\n');
      expect(tool.description).not.toContain('—');
      expect(Object.keys(tool.annotations).sort()).toEqual(annotationKeys);

      for (const otherName of toolNames) {
        if (otherName !== tool.name) expect(tool.description).not.toContain(otherName);
      }


      for (const property of collectPropertySchemas(tool.inputSchema)) {
        const description = property.schema.description;
        if (typeof description !== 'string' || !description.trim()) {
          throw new Error(`${tool.name} ${property.path} needs an argument description.`);
        }
        expect(description.length).toBeLessThanOrEqual(64);
        expect(description).not.toContain('\n');
        expect(description).not.toContain('—');
        for (const otherName of toolNames) {
          if (otherName !== tool.name) expect(description).not.toContain(otherName);
        }
      }
    }
  });

  test('advertises cross-tool guidance once and only for available tools', () => {
    const fullInstructions = serverInstructions(TOOL_DEFINITIONS);
    expect(fullInstructions).toContain('get_connected_instances');
    expect(fullInstructions).toContain('execute_luau');
    expect(fullInstructions).toContain('set_script_source');
    expect(fullInstructions).toContain('solo_playtest');
    expect(fullInstructions).toContain('preview');
    expect(fullInstructions).toContain('robloxstudio://tool-guides');
    expect(fullInstructions).toContain('selection action=view before capture_screenshot');
    expect(fullInstructions).not.toContain('—');

    const inspectorDefinitions = getReadOnlyTools();
    const inspectorNames = new Set(inspectorDefinitions.map((tool) => tool.name));
    const inspectorInstructions = serverInstructions(inspectorDefinitions);
    for (const definition of TOOL_DEFINITIONS) {
      if (!inspectorNames.has(definition.name)) {
        expect(inspectorInstructions).not.toContain(definition.name);
      }
    }
    expect(inspectorNames.has('selection')).toBe(true);
    expect(inspectorInstructions).toContain('selection action=view before capture_screenshot');
    expect(inspectorInstructions).toContain('get_connected_instances');
    expect(inspectorInstructions).toContain('get_roblox_docs');
    expect(inspectorInstructions).toContain('robloxstudio://tool-guides');
  });

  test('advertises annotations and returns validated structuredContent', async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const fakeTools = {} as RobloxStudioTools;
    const server = createToolServer({
      config: { name: 'test-server', version: '3.0.0', tools: [definition] },
      getTools: () => fakeTools,
      era: 'modern',
      invoke: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ placeId: 123, serverVersion: 'internal' }) }],
      }),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = (await client.listTools()).tools[0];
      expect(listed.outputSchema).toEqual({ type: 'object', additionalProperties: true });
      expect(listed.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('delivers screenshots as an image block plus structured metadata', async () => {
    const bridge = new BridgeService();
    bridge.registerInstance({ pluginSessionId: 'edit-session', instanceId: 'place:test', role: 'edit' });
    const tools = new RobloxStudioTools(bridge);
    const { client, close } = await connectedTools(['capture_screenshot'], tools);

    try {
      const call = client.callTool({ name: 'capture_screenshot', arguments: { format: 'png' } });
      const request = await answerPending(bridge, 'edit', () => ({
        width: 1,
        height: 1,
        data: Buffer.from([0, 0, 0, 255]).toString('base64'),
      }));
      expect(request.endpoint).toBe('/api/capture-screenshot');

      const result = await call;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        success: true,
        target: 'edit',
        width: 1,
        height: 1,
        format: 'png',
        mimeType: 'image/png',
      });
      expect(result.content).toEqual([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]);

      // A capture failure comes back as an isError result carrying the message,
      // instead of being hidden behind an output validation protocol error.
      const failing = client.callTool({ name: 'capture_screenshot', arguments: {} });
      await answerPending(bridge, 'edit', () => ({ error: 'viewport unavailable' }));
      const failed = await failing;
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toEqual({ error: 'screenshot_failed', message: 'viewport unavailable' });
    } finally {
      await close();
    }
  });

  test('delivers asset thumbnails as an image block plus structured metadata', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    (tools as unknown as { openCloudClient: object }).openCloudClient = {
      getAssetThumbnail: async (assetId: number) =>
        assetId === 1 ? { base64: 'aW1hZ2U=', mimeType: 'image/png' } : null,
    };
    const { client, close } = await connectedTools(['get_asset_thumbnail'], tools);

    try {
      const found = await client.callTool({ name: 'get_asset_thumbnail', arguments: { assetId: 1, size: '150x150' } });
      expect(found.isError).toBeFalsy();
      expect(found.structuredContent).toEqual({ success: true, assetId: 1, size: '150x150', mimeType: 'image/png' });
      expect(found.content).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);

      const missing = await client.callTool({ name: 'get_asset_thumbnail', arguments: { assetId: 2 } });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toEqual({
        error: 'thumbnail_unavailable',
        message: 'Thumbnail not available for asset 2.',
      });
    } finally {
      await close();
    }
  });

  test('delivers device matrix captures with the summary as structured content', async () => {
    const bridge = new BridgeService();
    bridge.registerInstance({ pluginSessionId: 'edit-session', instanceId: 'place:test', role: 'edit' });
    const tools = new RobloxStudioTools(bridge);
    const { client, close } = await connectedTools(['capture_device_matrix'], tools);

    try {
      const call = client.callTool({
        name: 'capture_device_matrix',
        arguments: { entries: [{ label: 'phone', deviceId: 'iphone_XR' }], settleSeconds: 0 },
      });
      const luau = (returnValue: unknown) => ({ success: true, returnValue: JSON.stringify(returnValue) });
      await answerPending(bridge, 'edit', () => luau({ activeDeviceId: 'default', isSimulating: false }));
      await answerPending(bridge, 'edit', () => luau({
        success: true,
        applied: { deviceId: 'iphone_XR' },
        before: { activeDeviceId: 'default', isSimulating: false },
        after: { activeDeviceId: 'iphone_XR', isSimulating: true },
      }));
      const capture = await answerPending(bridge, 'edit', () => ({
        width: 1,
        height: 1,
        data: Buffer.from([0, 0, 0, 255]).toString('base64'),
      }));
      expect(capture.endpoint).toBe('/api/capture-screenshot');
      await answerPending(bridge, 'edit', () => luau({
        success: true,
        applied: { stopSimulation: true },
        before: { activeDeviceId: 'iphone_XR', isSimulating: true },
        after: { activeDeviceId: 'default', isSimulating: false },
      }));

      const result = await call;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        target: 'edit',
        entries: [{ label: 'phone', screenshot: { width: 1, height: 1, format: 'jpeg' } }],
      });
      expect(result.content.some((block) => block.type === 'image')).toBe(true);
      expect(result.content.some((block) => block.type === 'text')).toBe(true);
    } finally {
      await close();
    }
  });

  test.each([
    ['legacy', undefined, true],
    ['2026-07-28', { mode: { pin: '2026-07-28' as const } }, false],
  ])('serves %s clients on the shared HTTP endpoint', async (_label, versionNegotiation, keepsTextProjection) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const getPlaceInfo = jest.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ placeId: 123 }) }],
    }));
    const tools = { getPlaceInfo } as unknown as RobloxStudioTools;
    const bridge = new BridgeService();
    const app = createHttpServer(
      tools,
      bridge,
      new Set(['get_place_info']),
      { name: 'test-server', version: '3.0.0', tools: [definition] },
    );
    const httpServer = await new Promise<HttpServer>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP port');

    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      versionNegotiation ? { versionNegotiation } : undefined,
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
      expect(result.content.some((block) => block.type === 'text')).toBe(keepsTextProjection);
      expect(getPlaceInfo).toHaveBeenCalled();
    } finally {
      await client.close().catch(() => {});
      await (app as any).closeMcpHandler?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  test('negotiates 2026-07-28 through the stdio entry', async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const fakeTools = {} as RobloxStudioTools;
    const eras: string[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      (context) => {
        eras.push(context.era);
        return createToolServer({
          config: { name: 'test-server', version: '3.0.0', tools: [definition] },
          getTools: () => fakeTools,
          era: context.era,
          invoke: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ placeId: 123 }) }],
          }),
        });
      },
      { transport: serverTransport },
    );
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
      expect(eras).toContain('modern');
    } finally {
      await client.close().catch(() => {});
      await handle.close().catch(() => {});
    }
  });
});
