import * as fs from 'fs';
import * as path from 'path';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function pluginSource(relative: string): string {
  return fs.readFileSync(path.join(repositoryRoot(), 'studio-plugin/src/modules', relative), 'utf8');
}

// The plugin runs inside Roblox Studio, so these pin the contract of the Luau the
// plugin generates rather than executing it.
describe('LuauExec require diagnostics and eval return serialization', () => {
  const luauExec = pluginSource('LuauExec.ts');
  const evalHandlers = pluginSource('handlers/EvalRuntimeHandlers.ts');

  test('eval payloads format their return value inside the game VM before crossing the bridge', () => {
    expect(evalHandlers).toContain('LuauExec.buildWrapper(code, PAYLOAD_INSTANCE_NAME, { serializeReturn: true })');
    expect(luauExec).toContain('local __mcp_SERIALIZE_RETURN = ${serializeReturn ? "true" : "false"}');
    expect(luauExec).toContain('errOrValue = __mcp_format_value(errOrValue)');
    // execute_luau keeps formatting on the plugin side, where no bridge is crossed.
    expect(luauExec).toMatch(/const wrapped = buildWrapper\(code\);/);
  });

  test('require recovery prefers diagnostics written during the require and labels every fallback', () => {
    expect(luauExec).toContain('__mcp_module_error_in(hist, module_path, history_start + 1, #hist)');
    expect(luauExec).toContain('__mcp_module_error_in(hist, module_path, 1, history_start)');
    expect(luauExec).toContain('recovered from an earlier Output error for');
    expect(luauExec).toContain('it may belong to another script');
    // Reading the history is guarded so it can never turn a working require into a failure.
    expect(luauExec).toContain('local ok, hist = pcall(function() return __mcp_LogService:GetLogHistory() end)');
  });

  test('the ModuleScript fallback snapshots the log length before requiring the payload', () => {
    expect(luauExec).toMatch(/const historyStart = logHistoryLength\(\);\s+const \[okReq, reqResult\] = pcall\(\(\) => require\(m\)\);/);
    expect(luauExec).toContain('recoverPayloadRequireError(reqResult, userLines, PAYLOAD_INSTANCE_NAME, historyStart)');
  });

  test('the wrapper line offset is derived from the prefix instead of maintained by hand', () => {
    expect(luauExec).toContain('const WRAPPER_LINE_OFFSET = countLines(wrapperPrefix(0, 0)) - 1;');
    expect(luauExec).not.toMatch(/const WRAPPER_LINE_OFFSET = \d+;/);
  });
});
