import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ScriptAnalysisError,
  analyzeScripts,
  buildAnalyzeArgs,
  buildLuaurc,
  collectUnresolvedRequires,
  dedupeDiagnostics,
  detectScriptMode,
  languageModeForTypeCheckMode,
  normalizeInstancePath,
  parseAnalyzeOutput,
  planWorkspaceLayout,
  sanitizeFileSegment,
  virtualPathToInstancePath,
  withWorkspaceLock,
  workspaceDirectoryFor,
  writeWorkspace,
  type SnapshotIndex,
  type SnapshotSourcesResponse,
} from '../script-analysis.js';
import type { ExecFileImpl, ExecResult } from '../luau-lsp-provisioner.js';

const tree: SnapshotIndex['tree'] = {
  name: 'game',
  className: 'DataModel',
  children: [
    {
      name: 'ServerScriptService',
      className: 'ServerScriptService',
      children: [
        { name: 'Main', className: 'Script', scriptIndex: 1 },
        {
          name: 'Modules',
          className: 'Folder',
          children: [
            {
              name: 'Inventory',
              className: 'ModuleScript',
              scriptIndex: 2,
              children: [{ name: 'Types', className: 'ModuleScript', scriptIndex: 3 }],
            },
            { name: 'inventory', className: 'ModuleScript', scriptIndex: 4 },
            { name: 'nul', className: 'ModuleScript', scriptIndex: 5 },
            { name: 'Bad/Name: v2', className: 'LocalScript', scriptIndex: 6 },
          ],
        },
      ],
    },
  ],
};

const index: SnapshotIndex = {
  token: 'tok-1',
  count: 6,
  typeCheckMode: 'Default',
  scripts: [
    { index: 1, path: 'game.ServerScriptService.Main', className: 'Script', sourceLength: 40 },
    { index: 2, path: 'game.ServerScriptService.Modules.Inventory', className: 'ModuleScript', sourceLength: 40 },
    { index: 3, path: 'game.ServerScriptService.Modules.Inventory.Types', className: 'ModuleScript', sourceLength: 40 },
    { index: 4, path: 'game.ServerScriptService.Modules.inventory', className: 'ModuleScript', sourceLength: 40 },
    { index: 5, path: 'game.ServerScriptService.Modules.nul', className: 'ModuleScript', sourceLength: 40 },
    { index: 6, path: 'game.ServerScriptService.Modules["Bad/Name: v2"]', className: 'LocalScript', sourceLength: 40 },
  ],
  tree,
};

const sourcesByIndex: Record<number, string> = {
  1: '--!strict\nlocal Inventory = require(script.Parent.Modules.Inventory)\nprint(Inventory.count)\n',
  2: 'local Types = require("@self/Types")\nreturn { count = 1 }\n',
  3: 'export type Item = { id: string }\nreturn {}\n',
  4: '--!nocheck\nreturn {}\n',
  5: 'return {}\n',
  6: 'local x = 1\n',
};

describe('script-analysis layout and modes', () => {
  test('maps Studio type-check modes onto .luaurc language modes', () => {
    expect(languageModeForTypeCheckMode('Default')).toBe('nonstrict');
    expect(languageModeForTypeCheckMode('Nonstrict')).toBe('nonstrict');
    expect(languageModeForTypeCheckMode('Strict')).toBe('strict');
    expect(languageModeForTypeCheckMode('NoCheck')).toBe('nocheck');
    expect(languageModeForTypeCheckMode(undefined)).toBe('nonstrict');
    expect(JSON.parse(buildLuaurc('strict'))).toEqual({ languageMode: 'strict' });
  });

  test('detects a leading mode directive but ignores one after code', () => {
    expect(detectScriptMode('--!strict\nlocal x = 1\n', 'nonstrict')).toBe('strict');
    expect(detectScriptMode('\n-- header\n--[[ block\n--!nocheck inside a block does not count\n]]\n--!nonstrict\nlocal x = 1', 'strict')).toBe('nonstrict');
    expect(detectScriptMode('local x = 1\n--!strict\n', 'nonstrict')).toBe('nonstrict');
    expect(detectScriptMode('', 'nocheck')).toBe('nocheck');
  });

  test('sanitizes instance names into portable file segments', () => {
    expect(sanitizeFileSegment('Inventory')).toBe('Inventory');
    expect(sanitizeFileSegment('Bad/Name: v2')).toBe('Bad_Name_ v2');
    expect(sanitizeFileSegment('nul')).toBe('_nul');
    expect(sanitizeFileSegment('CON.luau')).toBe('_CON.luau');
    expect(sanitizeFileSegment('..')).toBe('_');
    expect(sanitizeFileSegment('trailing. ')).toBe('trailing');
    expect(sanitizeFileSegment('.dir')).toBe('.dir');
    expect(sanitizeFileSegment('x'.repeat(200))).toHaveLength(120);
  });

  test('plans a Rojo layout with init containers, class suffixes, and collision-safe names', () => {
    const layout = planWorkspaceLayout(tree);
    expect(layout.files.get(1)).toBe('game/ServerScriptService/Main.server.luau');
    expect(layout.files.get(2)).toBe('game/ServerScriptService/Modules/Inventory/init.luau');
    expect(layout.files.get(3)).toBe('game/ServerScriptService/Modules/Inventory/Types.luau');
    expect(layout.files.get(4)).toBe('game/ServerScriptService/Modules/inventory_2.luau');
    expect(layout.files.get(5)).toBe('game/ServerScriptService/Modules/_nul.luau');
    expect(layout.files.get(6)).toBe('game/ServerScriptService/Modules/Bad_Name_ v2.client.luau');
    expect(layout.fileToIndex.get('game/ServerScriptService/Modules/Inventory/init.luau')).toBe(2);

    const modules = layout.sourcemap.children![0].children![1];
    expect(modules).toMatchObject({ name: 'Modules', className: 'Folder' });
    expect(modules.children![0]).toEqual({
      name: 'Inventory',
      className: 'ModuleScript',
      filePaths: ['game/ServerScriptService/Modules/Inventory/init.luau'],
      children: [{ name: 'Types', className: 'ModuleScript', filePaths: ['game/ServerScriptService/Modules/Inventory/Types.luau'] }],
    });
    expect(modules.children![3].name).toBe('Bad/Name: v2');
  });

  test('writes the workspace, prunes missing scripts from the sourcemap, and refuses escapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-analysis-'));
    try {
      const layout = planWorkspaceLayout(tree);
      const sources = new Map(Object.entries(sourcesByIndex).map(([k, v]) => [Number(k), v]));
      sources.delete(5);
      expect(writeWorkspace(root, layout, sources, buildLuaurc('nonstrict'))).toBe(5);
      expect(fs.readFileSync(path.join(root, 'game/ServerScriptService/Modules/Inventory/init.luau'), 'utf8')).toBe(sourcesByIndex[2]);
      expect(fs.existsSync(path.join(root, 'game/ServerScriptService/Modules/_nul.luau'))).toBe(false);
      const sourcemap = JSON.parse(fs.readFileSync(path.join(root, 'sourcemap.json'), 'utf8'));
      const nulNode = sourcemap.children[0].children[1].children[2];
      expect(nulNode).toEqual({ name: 'nul', className: 'ModuleScript' });
      expect(JSON.parse(fs.readFileSync(path.join(root, '.luaurc'), 'utf8'))).toEqual({ languageMode: 'nonstrict' });

      // A second run replaces the tree instead of accumulating stale files.
      fs.writeFileSync(path.join(root, 'game/stale.luau'), 'x');
      writeWorkspace(root, layout, sources, buildLuaurc('nonstrict'));
      expect(fs.existsSync(path.join(root, 'game/stale.luau'))).toBe(false);

      const escaping = planWorkspaceLayout(tree);
      escaping.files.set(1, '../outside.luau');
      expect(() => writeWorkspace(root, escaping, sources, buildLuaurc('nonstrict'))).toThrow(ScriptAnalysisError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes canonical paths and renders unresolved virtual paths', () => {
    expect(normalizeInstancePath('game.ServerScriptService.Main')).toBe('ServerScriptService.Main');
    expect(normalizeInstancePath('ServerScriptService.Main')).toBe('ServerScriptService.Main');
    expect(normalizeInstancePath('game["Odd Name"].X')).toBe('["Odd Name"].X');
    expect(normalizeInstancePath('game')).toBe('');
    expect(virtualPathToInstancePath('game/ServerScriptService/Modules/Inventory/Types')).toBe('game.ServerScriptService.Modules.Inventory.Types');
    expect(virtualPathToInstancePath('game/Workspace/Odd Name/X')).toBe('game.Workspace["Odd Name"].X');
    expect(workspaceDirectoryFor('/cache', 'place:8569')).toBe(path.join('/cache', 'analysis', 'place-8569'));
  });
});

describe('script-analysis output parsing', () => {
  const root = path.resolve(os.tmpdir(), 'analysis-root');
  const absolute = (relative: string) => path.join(root, ...relative.split('/'));

  test('parses lint and type-error lines from either stream, folds continuation lines, and reads unresolved requires', () => {
    // The gnu formatter emits diagnostics on stderr; keep one on stdout to prove both are read.
    const stdout = [
      'game/ServerScriptService/Main.server.luau:3.7-3.9: LocalUnused: Variable \'x\' is never used; prefix with \'_\' to silence',
      '',
    ].join('\n');
    const stderr = [
      '[INFO] Loading definitions file: @roblox - defs.d.luau',
      '[WARN] client does not allow didChangeWatchedFiles registration',
      `${absolute('game/ServerScriptService/Modules/Inventory/init.luau')} [game/ServerScriptService/Modules/Inventory]:2.10-2.15: TypeError: Type 'string' could not be converted into 'number'`,
      'caused by:',
      "\tExpected this to be 'number', but got 'string'",
      'Error opening game/ServerScriptService/Modules/Inventory/Types',
      `${absolute('game/ServerScriptService/Modules/Inventory/init.luau')} [game/ServerScriptService/Modules/Inventory]:2.10-2.15: TypeError: Type 'string' could not be converted into 'number'`,
      'caused by:',
      "\tExpected this to be 'number', but got 'string'",
      '/elsewhere/other.luau:1.1-1.2: TypeError: not ours',
      'Error opening game/ServerScriptService/Modules/Inventory/Types',
      '',
    ].join('\n');

    const parsed = parseAnalyzeOutput(stdout, stderr, root);
    expect([...parsed.byFile.keys()]).toEqual([
      'game/ServerScriptService/Main.server.luau',
      'game/ServerScriptService/Modules/Inventory/init.luau',
    ]);
    expect(parsed.byFile.get('game/ServerScriptService/Main.server.luau')).toEqual([
      { line: 3, col: 7, endLine: 3, endCol: 9, kind: 'LocalUnused', severity: 'warning', message: "Variable 'x' is never used; prefix with '_' to silence" },
    ]);
    const typeErrors = parsed.byFile.get('game/ServerScriptService/Modules/Inventory/init.luau')!;
    expect(typeErrors).toHaveLength(2);
    expect(typeErrors[0]).toMatchObject({
      line: 2, col: 10, endLine: 2, endCol: 15, kind: 'TypeError', severity: 'error',
      message: "Type 'string' could not be converted into 'number' caused by: Expected this to be 'number', but got 'string'",
    });
    expect(dedupeDiagnostics(typeErrors)).toHaveLength(1);
    expect(parsed.unattributed).toBe(1);
    expect(parsed.unresolvedRequires).toEqual(['game/ServerScriptService/Modules/Inventory/Types']);
    expect(parsed.errors).toEqual([]);
  });

  test('folds "Unknown require" type errors into the unresolved-require list as virtual paths', () => {
    const stderr = [
      `${absolute('game/ServerScriptService/Main.server.luau')} [game/ServerScriptService/Main]:2.1-2.9: TypeError: Unknown require: game/ReplicatedStorage/Shared/Util`,
      `${absolute('game/ServerScriptService/Main.server.luau')} [game/ServerScriptService/Main]:3.1-3.9: TypeError: Unknown require: ${absolute('game/ServerStorage/Tests/Child/init.luau')}`,
      `${absolute('game/ServerScriptService/Main.server.luau')} [game/ServerScriptService/Main]:4.1-4.9: TypeError: Unknown require: ${absolute('game/ServerStorage/Tests/Sibling.client.luau')}`,
      'caused by:',
      '\tsome detail',
      `${absolute('game/ServerScriptService/Main.server.luau')} [game/ServerScriptService/Main]:5.1-5.9: TypeError: Unknown require: /elsewhere/nope.luau`,
      'Error opening game/ReplicatedStorage/Shared/Util',
      '',
    ].join('\n');
    const parsed = parseAnalyzeOutput('', stderr, root);
    expect(collectUnresolvedRequires(parsed, root)).toEqual([
      'game/ReplicatedStorage/Shared/Util',
      'game/ServerStorage/Tests/Child',
      'game/ServerStorage/Tests/Sibling',
    ]);
  });

  test('collects analyzer error lines from stderr', () => {
    const parsed = parseAnalyzeOutput('', '[ERROR] Failed to load definitions file\nerror: no files provided\n', root);
    expect(parsed.errors).toEqual(['[ERROR] Failed to load definitions file', 'error: no files provided']);
  });

  test('builds the luau-lsp command line from the invocation', () => {
    const args = buildAnalyzeArgs({
      binaryPath: 'luau-lsp',
      workspaceRoot: root,
      definitionsPath: '/defs/globalTypes.roblox-vector.d.luau',
      targets: ['game'],
      newSolver: false,
      strictDatamodelTypes: false,
      timeoutMs: 1000,
    });
    expect(args).toEqual([
      'analyze', '--platform', 'roblox', '--sourcemap', 'sourcemap.json',
      '--definitions=@roblox=/defs/globalTypes.roblox-vector.d.luau', '--base-luaurc', '.luaurc',
      '--formatter', 'gnu', '--no-strict-dm-types', 'game',
    ]);
    const strictNew = buildAnalyzeArgs({
      binaryPath: 'luau-lsp', workspaceRoot: root, definitionsPath: 'd', targets: ['game/x.luau'],
      newSolver: true, strictDatamodelTypes: true, timeoutMs: 1000,
    });
    expect(strictNew).not.toContain('--no-strict-dm-types');
    expect(strictNew).toContain('--flag:LuauSolverV2=true');
    expect(strictNew[strictNew.length - 1]).toBe('game/x.luau');
  });
});

describe('analyzeScripts end to end with a fake analyzer', () => {
  let workspaceRoot: string;
  const binary = { binaryPath: '/fake/luau-lsp', version: '1.69.0', source: 'cache' as const, warnings: [] };
  const definitions = { path: '/fake/defs.d.luau', version: '1.69.0', vectorPatch: true };

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const fetchIndex = async () => index;
  const fetchSources = async (token: string, from: number, to: number): Promise<SnapshotSourcesResponse> => {
    if (token !== 'tok-1') return { error: 'expired', code: 'snapshot_expired' };
    const sources = [];
    for (let i = from; i <= to; i++) {
      sources.push({ index: i, path: index.scripts[i - 1].path, className: index.scripts[i - 1].className, source: sourcesByIndex[i] });
    }
    return { token, from, to, sources };
  };

  function fakeAnalyzer(output: (cwd: string) => ExecResult): { calls: { file: string; args: string[]; cwd?: string }[]; execFileImpl: ExecFileImpl } {
    const calls: { file: string; args: string[]; cwd?: string }[] = [];
    const execFileImpl: ExecFileImpl = async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return output(options.cwd ?? '');
    };
    return { calls, execFileImpl };
  }

  const diagnosticsOutput = (cwd: string): ExecResult => ({
    exitCode: 1,
    stdout: '',
    stderr: [
      '[INFO] Loading definitions file: @roblox - defs.d.luau',
      'game/ServerScriptService/Main.server.luau:3.7-3.9: LocalUnused: Variable \'x\' is never used',
      `${path.join(cwd, 'game', 'ServerScriptService', 'Main.server.luau')} [game/ServerScriptService/Main]:3.1-3.5: TypeError: Key 'count' not found in table`,
      `${path.join(cwd, 'game', 'ServerScriptService', 'Modules', 'Inventory', 'init.luau')} [game/ServerScriptService/Modules/Inventory]:1.15-1.30: TypeError: Unknown require: unsupported path`,
      'Error opening game/ServerScriptService/Modules/Inventory/Types',
      `${path.join(cwd, 'game', 'ServerScriptService', 'Modules', 'Inventory', 'init.luau')} [game/ServerScriptService/Modules/Inventory]:1.15-1.30: TypeError: Unknown require: unsupported path`,
      '',
    ].join('\n'),
  });

  test('analyzes the whole place: snapshots in batches, runs luau-lsp, dedupes, hides lints by default', async () => {
    const analyzer = fakeAnalyzer(diagnosticsOutput);
    const result = await analyzeScripts({}, {
      fetchIndex, fetchSources, binary, definitions, workspaceRoot,
      execFileImpl: analyzer.execFileImpl, batchBytes: 100,
    });

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0].file).toBe('/fake/luau-lsp');
    expect(analyzer.calls[0].cwd).toBe(workspaceRoot);
    expect(analyzer.calls[0].args[analyzer.calls[0].args.length - 1]).toBe('game');
    expect(fs.existsSync(path.join(workspaceRoot, 'game', 'ServerScriptService', 'Main.server.luau'))).toBe(true);

    expect(result.scope).toBe('place');
    expect(result.includeLints).toBe(false);
    expect(result.engine).toMatchObject({ luauLsp: '1.69.0', binarySource: 'cache', solver: 'old', vectorPatch: true, strictDatamodelTypes: false });
    expect(result.place).toEqual({ typeCheckMode: 'Default', defaultMode: 'nonstrict', scripts: 6, analyzed: 6, skipped: 0 });
    expect(result.scripts.map((script) => script.path)).toEqual([
      'game.ServerScriptService.Main',
      'game.ServerScriptService.Modules.Inventory',
    ]);
    expect(result.scripts[0]).toMatchObject({ className: 'Script', mode: 'strict' });
    expect(result.scripts[0].diagnostics).toEqual([
      { line: 3, col: 1, endLine: 3, endCol: 5, kind: 'TypeError', severity: 'error', message: "Key 'count' not found in table" },
    ]);
    expect(result.scripts[1].diagnostics).toHaveLength(1);
    expect(result.totals).toEqual({ typeErrors: 2, lints: 0, scriptsWithDiagnostics: 2, returned: 2 });
    expect(result.truncated).toBe(false);
    // Both the "Error opening" line and the "Unknown require" type error name the same module.
    expect(result.unresolvedRequires).toEqual([
      { virtualPath: 'game/ServerScriptService/Modules/Inventory/Types', instancePath: 'game.ServerScriptService.Modules.Inventory.Types' },
      { virtualPath: 'unsupported path', instancePath: 'game["unsupported path"]' },
    ]);
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('includes lints on request and honors the limit with a truncated flag', async () => {
    const analyzer = fakeAnalyzer(diagnosticsOutput);
    const result = await analyzeScripts({ includeLints: true, limit: 2 }, {
      fetchIndex, fetchSources, binary, definitions, workspaceRoot, execFileImpl: analyzer.execFileImpl,
    });
    expect(result.totals).toEqual({ typeErrors: 2, lints: 1, scriptsWithDiagnostics: 2, returned: 2 });
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(2);
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0].diagnostics.map((d) => d.kind)).toEqual(['TypeError', 'LocalUnused']);
  });

  test('scopes to one script: analyzes only its file and reports it even when clean', async () => {
    const analyzer = fakeAnalyzer(diagnosticsOutput);
    const result = await analyzeScripts({ instancePath: 'ServerScriptService.Modules.Inventory.Types', solver: 'new', strictDatamodelTypes: true }, {
      fetchIndex, fetchSources, binary, definitions, workspaceRoot, execFileImpl: analyzer.execFileImpl,
    });
    const args = analyzer.calls[0].args;
    expect(args[args.length - 1]).toBe('game/ServerScriptService/Modules/Inventory/Types.luau');
    expect(args).toContain('--flag:LuauSolverV2=true');
    expect(args).not.toContain('--no-strict-dm-types');
    expect(result.scope).toBe('script');
    expect(result.instancePath).toBe('game.ServerScriptService.Modules.Inventory.Types');
    expect(result.engine.solver).toBe('new');
    expect(result.scripts).toEqual([
      { path: 'game.ServerScriptService.Modules.Inventory.Types', className: 'ModuleScript', mode: 'nonstrict', diagnostics: [] },
    ]);
    expect(result.totals).toEqual({ typeErrors: 0, lints: 0, scriptsWithDiagnostics: 0, returned: 0 });
  });

  test('reports an unknown script path, plugin snapshot failures, and analyzer failures as coded errors', async () => {
    const analyzer = fakeAnalyzer(diagnosticsOutput);
    const baseDeps = { fetchIndex, fetchSources, binary, definitions, workspaceRoot, execFileImpl: analyzer.execFileImpl };

    await expect(analyzeScripts({ instancePath: 'game.Workspace.Nope' }, baseDeps))
      .rejects.toMatchObject({ code: 'script_not_found' });
    await expect(analyzeScripts({}, { ...baseDeps, fetchIndex: async () => ({ error: 'plugin offline' }) }))
      .rejects.toMatchObject({ code: 'snapshot_failed', message: 'plugin offline' });
    await expect(analyzeScripts({}, { ...baseDeps, fetchSources: async () => ({ error: 'gone', code: 'snapshot_expired' }) }))
      .rejects.toMatchObject({ code: 'snapshot_expired' });

    const broken = fakeAnalyzer(() => ({ exitCode: 1, stdout: '', stderr: '[ERROR] Failed to read definitions\n' }));
    await expect(analyzeScripts({}, { ...baseDeps, execFileImpl: broken.execFileImpl }))
      .rejects.toMatchObject({ code: 'analyzer_failed' });

    const crashed = fakeAnalyzer(() => ({ exitCode: 139, stdout: '', stderr: 'segfault' }));
    await expect(analyzeScripts({}, { ...baseDeps, execFileImpl: crashed.execFileImpl }))
      .rejects.toThrow(/exited with 139/);
  });

  test('skips scripts that vanished or moved between the index and the source batch', async () => {
    const analyzer = fakeAnalyzer(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const flakySources = async (token: string, from: number, to: number): Promise<SnapshotSourcesResponse> => {
      const response = await fetchSources(token, from, to);
      response.sources = response.sources!.map((entry) => (
        entry.index === 4 ? { index: 4, missing: true } : entry.index === 5 ? { ...entry, path: 'game.Moved' } : entry
      ));
      return response;
    };
    const result = await analyzeScripts({}, {
      fetchIndex, fetchSources: flakySources, binary, definitions, workspaceRoot, execFileImpl: analyzer.execFileImpl,
    });
    expect(result.place).toMatchObject({ analyzed: 4, skipped: 2 });
    expect(result.scripts).toEqual([]);
  });

  test('serializes runs that share a workspace', async () => {
    const order: string[] = [];
    const first = withWorkspaceLock('w', async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first-end');
      return 1;
    });
    const second = withWorkspaceLock('w', async () => {
      order.push('second-start');
      return 2;
    });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);

    await expect(withWorkspaceLock('w', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withWorkspaceLock('w', async () => 'after failure')).resolves.toBe('after failure');
  });
});
