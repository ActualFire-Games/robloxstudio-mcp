import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { getApiDumpCacheDir } from './api-dump.js';
import { extractZipEntry } from './zip-extract.js';

// analyze_scripts runs luau-lsp (the open-source Luau type checker and linter
// Studio's Script Analysis is built on) over a snapshot of the place. Studio
// exposes no API for reading its own diagnostics, so the binary has to exist
// on the MCP host. Resolution order: explicit env override, a recent enough
// install on PATH, the cached pinned release, then a pinned download.
export const LUAU_LSP_VERSION = '1.69.0';
// First release whose analyze mode resolves @game/@self string requires through
// a sourcemap. Older binaries type every such require as unknown.
export const MIN_LUAU_LSP_VERSION = '1.67.0';
export const LUAU_LSP_ENV = 'ROBLOX_STUDIO_LUAU_LSP';

const RELEASE_BASE_URL = `https://github.com/JohnnyMorganz/luau-lsp/releases/download/${LUAU_LSP_VERSION}`;
const DEFINITIONS_URL = `https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/${LUAU_LSP_VERSION}/scripts/globalTypes.d.luau`;
// The real definitions file is ~800 KB; a small body is an error page.
const MIN_DEFINITIONS_LENGTH = 100_000;
const DEFINITIONS_SANITY_MARKER = 'declare extern type Instance';
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const EXECUTABLE_MODE = 0o755;

export interface ReleaseAsset {
  asset: string;
  sha256: string;
  binary: string;
}

// SHA-256 of each release zip as published at RELEASE_BASE_URL. Windows on ARM
// and both macOS architectures run the x64/universal builds. Bumping
// LUAU_LSP_VERSION means recomputing every hash.
const WIN64: ReleaseAsset = {
  asset: 'luau-lsp-win64.zip',
  sha256: 'faea1b177f4761e4c34e0dab72009a2fdd00f21d61f3f7b7c1fe1ac3f38a05d2',
  binary: 'luau-lsp.exe',
};
const MACOS: ReleaseAsset = {
  asset: 'luau-lsp-macos.zip',
  sha256: '4e93204901d892b227a4de15c9d4742176c15e9461d208cadafa1bcd58ec1ae3',
  binary: 'luau-lsp',
};
export const RELEASE_ASSETS: Record<string, ReleaseAsset> = {
  'win32-x64': WIN64,
  'win32-arm64': WIN64,
  'darwin-x64': MACOS,
  'darwin-arm64': MACOS,
  'linux-x64': {
    asset: 'luau-lsp-linux-x86_64.zip',
    sha256: '4457aeb690d3c22e04567f38c6259ac259a1673ec022758b9cb81af2a0e66c41',
    binary: 'luau-lsp',
  },
  'linux-arm64': {
    asset: 'luau-lsp-linux-arm64.zip',
    sha256: 'b0c78fe40defe71b9fa6381390a590f2040897980a0cf31f0a23c165ad27ebbb',
    binary: 'luau-lsp',
  },
};

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export type ExecFileImpl = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

// Resolves on any exit code so callers can read luau-lsp's output (it exits 1
// whenever it reports diagnostics); rejects only when the process could not
// run or was killed by the timeout.
export const defaultExecFile: ExecFileImpl = (file, args, options) => new Promise((resolve, reject) => {
  execFile(
    file,
    args,
    { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, windowsHide: true, encoding: 'utf8' },
    (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code !== undefined && typeof (error as { code?: unknown }).code === 'string') {
        reject(new Error(`Could not run ${file}: ${error.message}`));
        return;
      }
      if (error && (error as { killed?: boolean }).killed) {
        reject(new Error(`${path.basename(file)} timed out after ${options.timeoutMs} ms`));
        return;
      }
      const exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    },
  );
});

export interface ProvisionDeps {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  platformKey?: string;
  execFileImpl?: ExecFileImpl;
  log?: (message: string) => void;
}

export type LuauLspSource = 'env' | 'path' | 'cache' | 'download';

export interface ResolvedLuauLsp {
  binaryPath: string;
  version: string;
  source: LuauLspSource;
  warnings: string[];
}

export interface ResolvedDefinitions {
  path: string;
  version: string;
  vectorPatch: boolean;
}

export function getLuauLspCacheDir(): string {
  return path.join(getApiDumpCacheDir(), 'luau-lsp');
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

async function probeVersion(binaryPath: string, execFileImpl: ExecFileImpl): Promise<string> {
  const result = await execFileImpl(binaryPath, ['--version'], { timeoutMs: VERSION_PROBE_TIMEOUT_MS });
  const match = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`${binaryPath} did not report a version (exit ${result.exitCode})`);
  }
  return match[1];
}

// PATH is split with the host's delimiter (the target platform key only picks the
// release asset), and every binary spelling is tried so a Windows install is
// found without consulting PATHEXT.
function findOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const names = ['luau-lsp', 'luau-lsp.exe', 'luau-lsp.cmd'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadRelease(
  asset: ReleaseAsset,
  destination: string,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
): Promise<void> {
  const url = `${RELEASE_BASE_URL}/${asset.asset}`;
  log(`Downloading luau-lsp ${LUAU_LSP_VERSION} from ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`luau-lsp download failed with HTTP ${response.status} for ${url}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = sha256(archive);
  if (digest !== asset.sha256) {
    // Only ever run a binary whose contents match the hash recorded at pin time.
    throw new Error(`luau-lsp download for ${asset.asset} did not match the pinned SHA-256 (got ${digest}); refusing to install it`);
  }
  const binary = extractZipEntry(archive, asset.binary);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, binary, { mode: EXECUTABLE_MODE });
  fs.renameSync(temporary, destination);
  log(`Installed luau-lsp ${LUAU_LSP_VERSION} at ${destination}`);
}

export async function resolveLuauLspBinary(deps: ProvisionDeps = {}): Promise<ResolvedLuauLsp> {
  const env = deps.env ?? process.env;
  const platformKey = deps.platformKey ?? `${process.platform}-${process.arch}`;
  const execFileImpl = deps.execFileImpl ?? defaultExecFile;
  const cacheDir = deps.cacheDir ?? getLuauLspCacheDir();
  const log = deps.log ?? ((message: string) => console.error(message));
  const warnings: string[] = [];

  const override = env[LUAU_LSP_ENV]?.trim();
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`${LUAU_LSP_ENV} points to ${override}, which does not exist`);
    }
    const version = await probeVersion(override, execFileImpl);
    if (compareVersions(version, MIN_LUAU_LSP_VERSION) < 0) {
      warnings.push(`${LUAU_LSP_ENV} binary is luau-lsp ${version}; string requires resolve correctly only from ${MIN_LUAU_LSP_VERSION}`);
    }
    return { binaryPath: override, version, source: 'env', warnings };
  }

  const onPath = findOnPath(env);
  if (onPath) {
    try {
      const version = await probeVersion(onPath, execFileImpl);
      if (compareVersions(version, MIN_LUAU_LSP_VERSION) >= 0) {
        return { binaryPath: onPath, version, source: 'path', warnings };
      }
      log(`Ignoring luau-lsp ${version} on PATH (${onPath}); ${MIN_LUAU_LSP_VERSION} or newer is required`);
    } catch (error) {
      log(`Ignoring luau-lsp on PATH (${onPath}): ${(error as Error).message}`);
    }
  }

  const asset = RELEASE_ASSETS[platformKey];
  if (!asset) {
    throw new Error(
      `No pinned luau-lsp build for ${platformKey}. Install luau-lsp ${MIN_LUAU_LSP_VERSION}+ yourself and point ${LUAU_LSP_ENV} at it.`,
    );
  }
  const cached = path.join(cacheDir, LUAU_LSP_VERSION, asset.binary);
  if (fs.existsSync(cached)) {
    try {
      const version = await probeVersion(cached, execFileImpl);
      return { binaryPath: cached, version, source: 'cache', warnings };
    } catch (error) {
      log(`Cached luau-lsp at ${cached} is unusable (${(error as Error).message}); re-downloading`);
      fs.rmSync(cached, { force: true });
    }
  }

  await downloadRelease(asset, cached, deps.fetchImpl ?? fetch, log);
  const version = await probeVersion(cached, execFileImpl);
  return { binaryPath: cached, version, source: 'download', warnings };
}

const VECTOR3_CLASS_LINE = 'declare extern type Vector3 with';
const VECTOR_CLASS_LINE = 'declare extern type vector with';
const VECTOR3_ALIAS_LINE = 'export type Vector3 = vector';
const METADATA_PREFIX = '--#METADATA#';
// Mirrors Luau's embedded `vector` library declaration, retargeted at the
// renamed class so vector.create() and Vector3.new() produce the same type.
const VECTOR_LIBRARY_DECLARATION = `
declare vector: {
    create: (x: number, y: number, z: number?) -> vector,
    magnitude: (vec: vector) -> number,
    normalize: (vec: vector) -> vector,
    cross: (vec1: vector, vec2: vector) -> vector,
    dot: (vec1: vector, vec2: vector) -> number,
    angle: (vec1: vector, vec2: vector, axis: vector?) -> number,
    floor: (vec: vector) -> vector,
    ceil: (vec: vector) -> vector,
    abs: (vec: vector) -> vector,
    sign: (vec: vector) -> vector,
    clamp: (vec: vector, min: vector, max: vector) -> vector,
    max: (vector, ...vector) -> vector,
    min: (vector, ...vector) -> vector,
    lerp: (vec1: vector, vec2: vector, t: number) -> vector,
    zero: vector,
    one: vector,
}
`;

// Studio treats the builtin `vector` type and Vector3 as one type (uppercase
// X/Y/Z, Magnitude, CFrame overloads). luau-lsp's generated definitions declare
// Vector3 as a separate class, so any script annotated with `vector` or calling
// vector.create() drowns in false mismatches. Renaming the class to `vector` and
// aliasing Vector3 to it reproduces Studio's view without touching luau-lsp.
export function patchVectorDefinitions(text: string): { text: string; applied: boolean } {
  const lines = text.split('\n');
  if (lines.some((line) => line === VECTOR_CLASS_LINE)) {
    return { text, applied: true };
  }
  const classIndex = lines.findIndex((line) => line === VECTOR3_CLASS_LINE);
  if (classIndex === -1) {
    return { text, applied: false };
  }
  lines[classIndex] = VECTOR_CLASS_LINE;
  const aliasIndex = lines[0]?.startsWith(METADATA_PREFIX) ? 1 : 0;
  lines.splice(aliasIndex, 0, VECTOR3_ALIAS_LINE);
  return { text: `${lines.join('\n').replace(/\s*$/, '')}\n${VECTOR_LIBRARY_DECLARATION}`, applied: true };
}

export async function resolveLuauDefinitions(deps: ProvisionDeps = {}): Promise<ResolvedDefinitions> {
  const cacheDir = deps.cacheDir ?? getLuauLspCacheDir();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((message: string) => console.error(message));
  const rawPath = path.join(cacheDir, `globalTypes.${LUAU_LSP_VERSION}.d.luau`);
  const patchedPath = path.join(cacheDir, `globalTypes.${LUAU_LSP_VERSION}.roblox-vector.d.luau`);

  if (fs.existsSync(patchedPath)) {
    return { path: patchedPath, version: LUAU_LSP_VERSION, vectorPatch: true };
  }

  let raw: string;
  if (fs.existsSync(rawPath)) {
    raw = fs.readFileSync(rawPath, 'utf8');
  } else {
    const response = await fetchImpl(DEFINITIONS_URL);
    if (!response.ok) {
      throw new Error(`Roblox type definitions download failed with HTTP ${response.status} for ${DEFINITIONS_URL}`);
    }
    raw = await response.text();
    if (raw.length < MIN_DEFINITIONS_LENGTH || !raw.includes(DEFINITIONS_SANITY_MARKER)) {
      throw new Error(`Roblox type definitions from ${DEFINITIONS_URL} look malformed (${raw.length} bytes)`);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(rawPath, raw);
    log(`Downloaded Roblox type definitions for luau-lsp ${LUAU_LSP_VERSION}`);
  }

  const patched = patchVectorDefinitions(raw);
  if (!patched.applied) {
    log('Roblox type definitions no longer declare Vector3 as expected; running without the vector/Vector3 patch');
    return { path: rawPath, version: LUAU_LSP_VERSION, vectorPatch: false };
  }
  fs.writeFileSync(patchedPath, patched.text);
  return { path: patchedPath, version: LUAU_LSP_VERSION, vectorPatch: true };
}
