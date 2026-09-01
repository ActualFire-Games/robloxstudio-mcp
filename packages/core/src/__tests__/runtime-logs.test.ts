import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const PLACE = 'place:test';

function register(bridge: BridgeService, role: string) {
  bridge.registerInstance({ pluginSessionId: `${role}-session`, instanceId: PLACE, role });
}

// Answers the next plugin request queued for `role`, the way the Studio plugin's
// poll loop would, and returns the request it answered.
async function answer(
  bridge: BridgeService,
  role: string,
  respond: (request: { endpoint: string; data: any }) => unknown,
): Promise<{ endpoint: string; data: any }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = bridge.getPendingRequest(PLACE, role);
    if (pending) {
      bridge.resolveRequest(pending.requestId, respond(pending.request));
      return pending.request;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for a ${role} plugin request`);
}

function parse(result: { content: Array<{ type: string; text?: string }> }): any {
  const first = result.content[0];
  if (first.type !== 'text' || typeof first.text !== 'string') throw new Error('expected a text response');
  return JSON.parse(first.text);
}

const entry = (seq: number, ts: number, message: string, extra: Record<string, unknown> = {}) =>
  ({ seq, ts, level: 'OUT', message, ...extra });

const idle = () => ({ session: { phase: 'idle' } });

describe('get_runtime_logs cursors', () => {
  test('a nextSince map dispatches one cursor per buffer and comes back as nextSince', async () => {
    const bridge = new BridgeService();
    for (const role of ['edit', 'server', 'client']) register(bridge, role);
    const tools = new RobloxStudioTools(bridge);

    const call = tools.getRuntimeLogs('all', { edit: 1016, server: 513, 'client-1': 591, stale: 7 }, undefined, undefined, PLACE);
    call.catch(() => {});
    await answer(bridge, 'edit', idle);

    const dispatched: Record<string, unknown> = {};
    for (const role of ['edit', 'server', 'client-1']) {
      const request = await answer(bridge, role, (req) => {
        dispatched[role] = req.data.since;
        return { capturedBy: role, entries: [], totalDropped: 0, nextSince: req.data.since + 1 };
      });
      expect(request.endpoint).toBe('/api/get-runtime-logs');
    }
    expect(dispatched).toEqual({ edit: 1016, server: 513, 'client-1': 591 });

    const body = parse(await call);
    expect(body.nextSince).toEqual({ edit: 1017, server: 514, 'client-1': 592 });
    expect(body.perCaptureNextSince).toEqual(body.nextSince);
    expect(body.duplicatesRemoved).toBe(0);
  });

  test('a numeric since still goes to every buffer for callers that read one target', async () => {
    const bridge = new BridgeService();
    for (const role of ['edit', 'server']) register(bridge, role);
    const tools = new RobloxStudioTools(bridge);

    const call = tools.getRuntimeLogs('all', 5, undefined, undefined, PLACE);
    call.catch(() => {});
    await answer(bridge, 'edit', idle);
    const dispatched: Record<string, unknown> = {};
    for (const role of ['edit', 'server']) {
      await answer(bridge, role, (req) => {
        dispatched[role] = req.data.since;
        return { capturedBy: role, entries: [], totalDropped: 0, nextSince: 5 };
      });
    }
    await call;
    expect(dispatched).toEqual({ edit: 5, server: 5 });
  });

  test('since="playtest" trims the edit buffer to the runtime peers and keeps runtime buffers whole', async () => {
    const bridge = new BridgeService();
    register(bridge, 'edit');
    const tools = new RobloxStudioTools(bridge);

    await expect(tools.getRuntimeLogs('all', 'playtest', undefined, undefined, PLACE))
      .rejects.toThrow(/needs a running playtest/);

    register(bridge, 'server');
    register(bridge, 'client');
    const nowSec = Date.now() / 1000;

    const call = tools.getRuntimeLogs('all', 'playtest', undefined, undefined, PLACE);
    call.catch(() => {});
    await answer(bridge, 'edit', idle);
    const sinceSent: Record<string, unknown> = {};
    await answer(bridge, 'edit', (req) => {
      sinceSent.edit = req.data.since;
      return {
        capturedBy: 'edit',
        entries: [
          entry(1, nowSec - 3600, 'old compile check from edit mode'),
          entry(2, nowSec + 5, 'edit-mode print during the playtest'),
        ],
        totalDropped: 0,
        nextSince: 2,
      };
    });
    await answer(bridge, 'server', (req) => {
      sinceSent.server = req.data.since;
      // Seeded from GetLogHistory before the plugin registered: still part of this playtest.
      return { capturedBy: 'server', entries: [entry(1, nowSec - 1, 'seeded server startup line')], totalDropped: 0, nextSince: 1 };
    });
    await answer(bridge, 'client-1', (req) => {
      sinceSent['client-1'] = req.data.since;
      return { capturedBy: 'client', entries: [entry(1, nowSec + 1, 'client line')], totalDropped: 0, nextSince: 1 };
    });

    const body = parse(await call);
    expect(sinceSent).toEqual({ edit: undefined, server: undefined, 'client-1': undefined });
    expect(body.entries.map((e: any) => [e.capturedBy, e.message])).toEqual([
      ['server', 'seeded server startup line'],
      ['client-1', 'client line'],
      ['edit', 'edit-mode print during the playtest'],
    ]);
    expect(typeof body.playtestStartedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.playtestStartedAt))).toBe(false);
  });

  test('since="playtest" also trims a single edit target', async () => {
    const bridge = new BridgeService();
    for (const role of ['edit', 'server']) register(bridge, role);
    const tools = new RobloxStudioTools(bridge);
    const nowSec = Date.now() / 1000;

    const call = tools.getRuntimeLogs('edit', 'playtest', undefined, undefined, PLACE);
    call.catch(() => {});
    await answer(bridge, 'edit', idle);
    await answer(bridge, 'edit', () => ({
      capturedBy: 'edit',
      entries: [entry(1, nowSec - 3600, 'stale'), entry(2, nowSec + 5, 'fresh')],
      totalDropped: 0,
      nextSince: 2,
    }));

    const body = parse(await call);
    expect(body.entries.map((e: any) => e.message)).toEqual(['fresh']);
    expect(body.nextSince).toBe(2);
    expect(typeof body.playtestStartedAt).toBe('string');
  });

  test('collapses mirrored lines across buffers, keeps repeats within one buffer, drops empty data', async () => {
    const bridge = new BridgeService();
    for (const role of ['edit', 'server']) register(bridge, role);
    const tools = new RobloxStudioTools(bridge);

    const call = tools.getRuntimeLogs('all', undefined, undefined, undefined, PLACE);
    call.catch(() => {});
    await answer(bridge, 'edit', idle);
    await answer(bridge, 'edit', () => ({
      capturedBy: 'edit',
      entries: [entry(1, 100.0, 'hello', { data: [] }), entry(2, 100.5, 'hello')],
      totalDropped: 0,
      nextSince: 2,
    }));
    await answer(bridge, 'server', () => ({
      capturedBy: 'server',
      entries: [entry(1, 100.2, 'hello'), entry(2, 100.3, 'only server', { data: { rank: 1 } })],
      totalDropped: 0,
      nextSince: 2,
    }));

    const body = parse(await call);
    expect(body.entries.map((e: any) => [e.capturedBy, e.message])).toEqual([
      ['edit', 'hello'],
      ['server', 'only server'],
      ['edit', 'hello'],
    ]);
    expect(body.duplicatesRemoved).toBe(1);
    expect('data' in body.entries[0]).toBe(false);
    expect(body.entries[1].data).toEqual({ rank: 1 });
  });

  test('rejects cursors that are not a number, a per-buffer map, or "playtest"', async () => {
    const bridge = new BridgeService();
    register(bridge, 'edit');
    const tools = new RobloxStudioTools(bridge);

    await expect(tools.getRuntimeLogs('edit', 'yesterday', undefined, undefined, PLACE)).rejects.toThrow(/since must be/);
    await expect(tools.getRuntimeLogs('edit', { edit: -1 }, undefined, undefined, PLACE)).rejects.toThrow(/nextSince/);
    await expect(tools.getRuntimeLogs('edit', [1, 2], undefined, undefined, PLACE)).rejects.toThrow(/since must be/);
  });
});
