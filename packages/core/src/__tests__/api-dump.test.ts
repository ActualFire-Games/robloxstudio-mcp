import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getClassInfoFromDump, _clearApiDumpCache } from '../api-dump.js';

// Minimal dump exercising inheritance, security shapes, tags, and subclasses.
// Padded with filler classes to clear the malformed-dump size floor.
function makeFixtureDump(): object {
  const classes: object[] = [
    {
      Name: 'Object',
      Superclass: '<<<ROOT>>>',
      MemoryCategory: 'Instances',
      Members: [
        {
          MemberType: 'Function',
          Name: 'IsA',
          Parameters: [{ Name: 'className', Type: { Category: 'Primitive', Name: 'string' } }],
          ReturnType: { Category: 'Primitive', Name: 'bool' },
          Security: 'None',
        },
      ],
    },
    {
      Name: 'Instance',
      Superclass: 'Object',
      MemoryCategory: 'Instances',
      Members: [
        {
          MemberType: 'Property',
          Name: 'Name',
          ValueType: { Category: 'Primitive', Name: 'string' },
          Security: { Read: 'None', Write: 'None' },
        },
        {
          MemberType: 'Property',
          Name: 'RobloxLocked',
          ValueType: { Category: 'Primitive', Name: 'bool' },
          Security: { Read: 'PluginSecurity', Write: 'PluginSecurity' },
        },
        {
          MemberType: 'Event',
          Name: 'ChildAdded',
          Parameters: [{ Name: 'child', Type: { Category: 'Class', Name: 'Instance' } }],
          Security: 'None',
        },
      ],
    },
    {
      Name: 'BasePart',
      Superclass: 'Instance',
      MemoryCategory: 'PhysicsParts',
      Tags: ['NotCreatable'],
      Members: [
        {
          MemberType: 'Property',
          Name: 'Anchored',
          ValueType: { Category: 'Primitive', Name: 'bool' },
          Security: { Read: 'None', Write: 'None' },
        },
        {
          MemberType: 'Property',
          Name: 'Mass',
          ValueType: { Category: 'Primitive', Name: 'float' },
          Security: { Read: 'None', Write: 'RobloxSecurity' },
          Tags: ['ReadOnly'],
        },
      ],
    },
    {
      Name: 'Part',
      Superclass: 'BasePart',
      MemoryCategory: 'PhysicsParts',
      Members: [
        {
          MemberType: 'Property',
          Name: 'Shape',
          ValueType: { Category: 'Enum', Name: 'PartType' },
          Security: { Read: 'None', Write: 'None' },
        },
      ],
    },
    {
      Name: 'DemoService',
      Superclass: 'Instance',
      MemoryCategory: 'Instances',
      Tags: ['NotCreatable', 'Service'],
      Members: [
        {
          MemberType: 'Function',
          Name: 'GetThingAsync',
          Parameters: [],
          ReturnType: { Category: 'Group', Name: 'Dictionary' },
          Security: 'None',
          Tags: ['Yields'],
        },
      ],
    },
  ];
  for (let i = 0; i < 120; i++) {
    classes.push({ Name: `Filler${i}`, Superclass: 'Instance', Members: [] });
  }
  return { Classes: classes, Enums: [], Version: 1 };
}

function makeFetchImpl(dump: object, version = '0.729.0.7290838'): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.includes('client-version')) {
      return { ok: true, status: 200, json: async () => ({ version, clientVersionUpload: 'version-test' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(dump) };
  });
}

describe('getClassInfoFromDump', () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearApiDumpCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-dump-test-'));
  });

  afterEach(() => {
    _clearApiDumpCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resolves own and inherited members with inheritedFrom labels', async () => {
    const fetchImpl = makeFetchImpl(makeFixtureDump());
    const info = await getClassInfoFromDump('Part', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });

    expect(info).not.toBeNull();
    expect(info!.superclassChain).toEqual(['BasePart', 'Instance', 'Object']);
    expect(info!.apiDumpVersion).toBe('0.729.0.7290838');

    const shape = info!.properties.find(p => p.name === 'Shape');
    expect(shape).toMatchObject({ valueType: 'Enum.PartType' });
    expect(shape!.inheritedFrom).toBeUndefined();

    const anchored = info!.properties.find(p => p.name === 'Anchored');
    expect(anchored!.inheritedFrom).toBe('BasePart');

    const isA = info!.methods.find(m => m.name === 'IsA');
    expect(isA!.inheritedFrom).toBe('Object');
    expect(isA!.signature).toBe('IsA(className: string) -> bool');

    const childAdded = info!.events.find(e => e.name === 'ChildAdded');
    expect(childAdded!.signature).toBe('(child: Instance)');
  });

  test('collapses and omits security correctly', async () => {
    const fetchImpl = makeFetchImpl(makeFixtureDump());
    const info = await getClassInfoFromDump('Part', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });

    const name = info!.properties.find(p => p.name === 'Name');
    expect(name!.security).toBeUndefined();

    const locked = info!.properties.find(p => p.name === 'RobloxLocked');
    expect(locked!.security).toBe('PluginSecurity');

    const mass = info!.properties.find(p => p.name === 'Mass');
    expect(mass!.security).toBe('read: None, write: RobloxSecurity');
    expect(mass!.tags).toEqual(['ReadOnly']);
  });

  test('reports class tags, subclasses, and yielding methods for services', async () => {
    const fetchImpl = makeFetchImpl(makeFixtureDump());
    const info = await getClassInfoFromDump('DemoService', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });

    expect(info!.tags).toEqual(['NotCreatable', 'Service']);
    const method = info!.methods.find(m => m.name === 'GetThingAsync');
    expect(method!.signature).toBe('GetThingAsync() -> Dictionary');
    expect(method!.tags).toEqual(['Yields']);

    const base = await getClassInfoFromDump('BasePart', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });
    expect(base!.subclasses).toEqual(['Part']);
  });

  test('returns null for an unknown class', async () => {
    const fetchImpl = makeFetchImpl(makeFixtureDump());
    const info = await getClassInfoFromDump('NotARealClass', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });
    expect(info).toBeNull();
  });

  test('writes a version-keyed disk cache and reuses it without refetching the dump', async () => {
    const fetchImpl = makeFetchImpl(makeFixtureDump());
    await getClassInfoFromDump('Part', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, 'api-dump-0.729.0.7290838.json'))).toBe(true);

    _clearApiDumpCache();
    const secondFetch = makeFetchImpl(makeFixtureDump());
    await getClassInfoFromDump('Part', { fetchImpl: secondFetch as any, cacheDir: tmpDir });
    // Only the cheap client-version request runs; the 7 MB dump comes from disk.
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  test('falls back to the newest cached dump when the network is unavailable', async () => {
    fs.writeFileSync(path.join(tmpDir, 'api-dump-0.700.0.1.json'), JSON.stringify(makeFixtureDump()));
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down');
    });

    const info = await getClassInfoFromDump('Part', { fetchImpl: fetchImpl as any, cacheDir: tmpDir });
    expect(info).not.toBeNull();
    expect(info!.apiDumpVersion).toBe('0.700.0.1');
  });

  test('throws when neither network nor cache is available', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down');
    });

    await expect(getClassInfoFromDump('Part', { fetchImpl: fetchImpl as any, cacheDir: tmpDir })).rejects.toThrow(
      /Unable to obtain Roblox API dump/,
    );
  });
});
