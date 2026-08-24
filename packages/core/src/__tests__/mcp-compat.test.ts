import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import {
  findToolGuideSection,
  registerResourceHandlers,
  TOOL_GUIDE_MARKDOWN,
  TOOL_GUIDE_SECTION_URI_PREFIX,
  TOOL_GUIDE_SECTIONS,
  TOOL_GUIDE_URI,
} from '../mcp-compat.js';
import { DOC_CATEGORIES } from '../roblox-docs.js';

describe('MCP resource handlers', () => {
  async function connectedPair() {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    registerResourceHandlers(server);
    server.registerTool('noop', {}, async () => ({ content: [] }));

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  }

  test('handles resource probes without hiding tools capability', async () => {
    const { server, client } = await connectedPair();
    try {
      expect(client.getServerCapabilities()).toEqual({
        // The tool guide section template offers slug completion, which registers the
        // completions capability alongside resources and tools.
        completions: {},
        resources: { listChanged: true },
        tools: { listChanged: true },
      });
      // The whole guide, plus every heading listed as its own readable resource.
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(expect.objectContaining({
        name: 'Roblox Studio MCP tool guide',
        uri: TOOL_GUIDE_URI,
        mimeType: 'text/markdown',
      }));
      for (const section of TOOL_GUIDE_SECTIONS) {
        expect(listed.resources).toContainEqual(expect.objectContaining({
          uri: `${TOOL_GUIDE_SECTION_URI_PREFIX}${section.slug}`,
          mimeType: 'text/markdown',
        }));
      }
      expect(listed.resources).toHaveLength(1 + TOOL_GUIDE_SECTIONS.length);
      await expect(client.readResource({ uri: 'robloxstudio://missing' }))
        .rejects.toThrow('Resource not found: robloxstudio://missing');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('addresses each tool guide heading as its own resource', async () => {
    const { server, client } = await connectedPair();
    try {
      // The guide is large; reading one section must not cost the whole document.
      const section = findToolGuideSection('debugging-and-profiling');
      expect(section).toBeDefined();

      const result = await client.readResource({
        uri: `${TOOL_GUIDE_SECTION_URI_PREFIX}debugging-and-profiling`,
      });
      const [content] = result.contents;
      expect('text' in content).toBe(true);
      const text = (content as { text: string }).text;
      expect(text).toBe(section!.markdown);
      expect(text).toContain('## Debugging and profiling');
      expect(text).toContain('capture_micro_profiler attributes frame time');
      // A section carries its own heading only, not the neighbouring ones.
      expect(text).not.toContain('## Creator Store and generated assets');
      expect(text.length).toBeLessThan(TOOL_GUIDE_MARKDOWN.length / 4);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('rejects an unknown tool guide section with the valid slugs', async () => {
    const { server, client } = await connectedPair();
    try {
      await expect(
        client.readResource({ uri: `${TOOL_GUIDE_SECTION_URI_PREFIX}not-a-section` }),
      ).rejects.toThrow(/debugging-and-profiling/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('splits the guide into sections without losing or duplicating content', () => {
    expect(TOOL_GUIDE_SECTIONS.length).toBeGreaterThan(1);

    // Every "## " heading in the guide becomes exactly one addressable section.
    const headings = TOOL_GUIDE_MARKDOWN.split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.slice(3).trim());
    expect(TOOL_GUIDE_SECTIONS.map((section) => section.title)).toEqual(headings);

    // Slugs are unique and URI-safe.
    const slugs = TOOL_GUIDE_SECTIONS.map((section) => section.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    // No bullet line is dropped by the split, and none is counted twice.
    const bulletsIn = (text: string) => text.split('\n').filter((line) => line.startsWith('- ')).length;
    const acrossSections = TOOL_GUIDE_SECTIONS.reduce((total, section) => total + bulletsIn(section.markdown), 0);
    expect(acrossSections).toBe(bulletsIn(TOOL_GUIDE_MARKDOWN));
  });

  test('serves detailed tool guidance on demand', async () => {
    const { server, client } = await connectedPair();
    try {
      const result = await client.readResource({ uri: TOOL_GUIDE_URI });
      expect(result.contents).toEqual([{
        uri: TOOL_GUIDE_URI,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }]);
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Script changes');
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Debugging and profiling');
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Creator Store and generated assets');
      expect(TOOL_GUIDE_MARKDOWN).not.toContain('—');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('exposes robloxdocs:// resource templates', async () => {
    const { server, client } = await connectedPair();
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      const templates = resourceTemplates.map(t => t.uriTemplate);
      // Every readable doc category must be discoverable via a template.
      for (const category of DOC_CATEGORIES) {
        expect(templates.some(t => t.startsWith(`robloxdocs://${category}/`))).toBe(true);
      }
      for (const template of resourceTemplates) {
        expect(template.mimeType).toBe('text/markdown');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('rejects robloxdocs URIs with unknown categories', async () => {
    const { server, client } = await connectedPair();
    try {
      await expect(client.readResource({ uri: 'robloxdocs://bogus/ProximityPrompt' }))
        .rejects.toThrow('not found');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
