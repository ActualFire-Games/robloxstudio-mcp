import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import {
  LUAU_LSP_ENV,
  LUAU_LSP_VERSION,
  RELEASE_ASSETS,
  compareVersions,
  patchVectorDefinitions,
  resolveLuauDefinitions,
  resolveLuauLspBinary,
  type ExecFileImpl,
} from '../luau-lsp-provisioner.js';

function zipWithSingleEntry(name: string, content: Buffer): Buffer {
  const data = zlib.deflateRawSync(content);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const localRecord = Buffer.concat([local, nameBytes, data]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, central, nameBytes, eocd]);
}

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!route) return new Response('not found', { status: 404 });
    return route[1]();
  }) as typeof fetch;
}

// Reports the version baked into the fake binary's contents, so a stale or
// foreign binary is distinguishable from the pinned download.
const versionFromContents: ExecFileImpl = async (file) => {
  const contents = fs.readFileSync(file, 'utf8');
  const match = contents.match(/version=(\S+)/);
  return { stdout: match ? `${match[1]}\n` : '', stderr: '', exitCode: match ? 0 : 1 };
};

describe('luau-lsp provisioner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luau-lsp-provisioner-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('compares dotted versions numerically', () => {
    expect(compareVersions('1.69.0', '1.67.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.67', '1.67.0')).toBe(0);
  });

  test('downloads the pinned release once, verifies its hash, and reuses the cache', async () => {
    const binaryContents = Buffer.from(`#!/bin/sh\n# version=${LUAU_LSP_VERSION}\n`);
    const archive = zipWithSingleEntry('luau-lsp', binaryContents);
    const platformKey = 'linux-x64';
    const asset = { ...RELEASE_ASSETS[platformKey], sha256: createHash('sha256').update(archive).digest('hex') };
    RELEASE_ASSETS[platformKey] = asset;
    let downloads = 0;
    const fetchImpl = fakeFetch({
      [asset.asset]: () => {
        downloads++;
        return new Response(new Uint8Array(archive), { status: 200 });
      },
    });
    const cacheDir = path.join(tempDir, 'cache');
    const logs: string[] = [];
    const deps = { fetchImpl, cacheDir, env: { PATH: '' }, platformKey, execFileImpl: versionFromContents, log: (m: string) => logs.push(m) };

    const first = await resolveLuauLspBinary(deps);
    expect(first.source).toBe('download');
    expect(first.version).toBe(LUAU_LSP_VERSION);
    expect(first.binaryPath).toBe(path.join(cacheDir, LUAU_LSP_VERSION, 'luau-lsp'));
    expect(fs.readFileSync(first.binaryPath).equals(binaryContents)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(first.binaryPath).mode & 0o111).not.toBe(0);
    }

    const second = await resolveLuauLspBinary(deps);
    expect(second.source).toBe('cache');
    expect(downloads).toBe(1);
  });

  test('refuses a download whose hash does not match the pin and installs nothing', async () => {
    const archive = zipWithSingleEntry('luau-lsp', Buffer.from('# version=9.9.9\n'));
    const platformKey = 'linux-arm64';
    const fetchImpl = fakeFetch({ [RELEASE_ASSETS[platformKey].asset]: () => new Response(new Uint8Array(archive), { status: 200 }) });
    const cacheDir = path.join(tempDir, 'cache');
    await expect(resolveLuauLspBinary({ fetchImpl, cacheDir, env: { PATH: '' }, platformKey, execFileImpl: versionFromContents, log: () => undefined }))
      .rejects.toThrow(/did not match the pinned SHA-256/);
    expect(fs.existsSync(path.join(cacheDir, LUAU_LSP_VERSION))).toBe(false);
  });

  test('prefers an explicit env override and warns when it is too old', async () => {
    const override = path.join(tempDir, 'my-luau-lsp');
    fs.writeFileSync(override, '# version=1.60.0\n');
    const resolved = await resolveLuauLspBinary({
      env: { [LUAU_LSP_ENV]: override, PATH: '' },
      platformKey: 'linux-x64',
      cacheDir: path.join(tempDir, 'cache'),
      execFileImpl: versionFromContents,
      fetchImpl: fakeFetch({}),
      log: () => undefined,
    });
    expect(resolved.source).toBe('env');
    expect(resolved.version).toBe('1.60.0');
    expect(resolved.warnings[0]).toMatch(/1\.67\.0/);

    await expect(resolveLuauLspBinary({ env: { [LUAU_LSP_ENV]: path.join(tempDir, 'missing') }, platformKey: 'linux-x64', execFileImpl: versionFromContents, log: () => undefined }))
      .rejects.toThrow(/does not exist/);
  });

  test('uses a PATH install when it is recent enough, otherwise falls through to the cache', async () => {
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir);
    const onPath = path.join(binDir, 'luau-lsp');
    fs.writeFileSync(onPath, '# version=1.68.0\n');
    const cacheDir = path.join(tempDir, 'cache');
    const cached = path.join(cacheDir, LUAU_LSP_VERSION, 'luau-lsp');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, `# version=${LUAU_LSP_VERSION}\n`);
    const deps = { env: { PATH: binDir }, platformKey: 'linux-x64', cacheDir, execFileImpl: versionFromContents, fetchImpl: fakeFetch({}), log: () => undefined };

    expect((await resolveLuauLspBinary(deps)).source).toBe('path');

    fs.writeFileSync(onPath, '# version=1.50.0\n');
    const fallback = await resolveLuauLspBinary(deps);
    expect(fallback.source).toBe('cache');
    expect(fallback.binaryPath).toBe(cached);
  });

  test('rejects platforms without a pinned build with install guidance', async () => {
    await expect(resolveLuauLspBinary({ env: { PATH: '' }, platformKey: 'freebsd-x64', cacheDir: tempDir, execFileImpl: versionFromContents, log: () => undefined }))
      .rejects.toThrow(new RegExp(LUAU_LSP_ENV));
  });

  const definitionsFixture = [
    '--#METADATA#{"CREATABLE_INSTANCES": []}',
    'declare extern type Instance with',
    '\tName: string',
    'end',
    'declare extern type CFrame with',
    '\tfunction __mul(self, other: Vector3): Vector3',
    'end',
    'declare extern type Vector3 with',
    '\tX: number',
    '\tMagnitude: number',
    'end',
    'declare Vector3: {',
    '\tnew: (x: number?, y: number?, z: number?) -> Vector3,',
    '}',
    '',
  ].join('\n');

  test('patches Vector3 into the builtin vector type exactly once', () => {
    const first = patchVectorDefinitions(definitionsFixture);
    expect(first.applied).toBe(true);
    const lines = first.text.split('\n');
    expect(lines[0]).toMatch(/^--#METADATA#/);
    expect(lines[1]).toBe('export type Vector3 = vector');
    expect(lines).toContain('declare extern type vector with');
    expect(lines).not.toContain('declare extern type Vector3 with');
    expect(first.text).toContain('declare vector: {');
    expect(first.text).toContain('create: (x: number, y: number, z: number?) -> vector,');

    const again = patchVectorDefinitions(first.text);
    expect(again.applied).toBe(true);
    expect(again.text).toBe(first.text);

    const foreign = patchVectorDefinitions('declare extern type Instance with\nend\n');
    expect(foreign.applied).toBe(false);
    expect(foreign.text).toBe('declare extern type Instance with\nend\n');
  });

  test('downloads definitions, caches the raw file, and serves the patched copy', async () => {
    const padded = definitionsFixture + '-- padding\n'.repeat(12_000);
    let downloads = 0;
    const fetchImpl = fakeFetch({
      'scripts/globalTypes.d.luau': () => {
        downloads++;
        return new Response(padded, { status: 200 });
      },
    });
    const cacheDir = path.join(tempDir, 'cache');
    const first = await resolveLuauDefinitions({ fetchImpl, cacheDir, log: () => undefined });
    expect(first.vectorPatch).toBe(true);
    expect(first.version).toBe(LUAU_LSP_VERSION);
    expect(first.path).toBe(path.join(cacheDir, `globalTypes.${LUAU_LSP_VERSION}.roblox-vector.d.luau`));
    expect(fs.readFileSync(path.join(cacheDir, `globalTypes.${LUAU_LSP_VERSION}.d.luau`), 'utf8')).toBe(padded);
    expect(fs.readFileSync(first.path, 'utf8')).toContain('export type Vector3 = vector');

    const second = await resolveLuauDefinitions({ fetchImpl, cacheDir, log: () => undefined });
    expect(second.path).toBe(first.path);
    expect(downloads).toBe(1);
  });

  test('rejects a definitions download that is too small to be real', async () => {
    const fetchImpl = fakeFetch({ 'scripts/globalTypes.d.luau': () => new Response('<html>rate limited</html>', { status: 200 }) });
    await expect(resolveLuauDefinitions({ fetchImpl, cacheDir: path.join(tempDir, 'cache'), log: () => undefined }))
      .rejects.toThrow(/look malformed/);
  });
});
