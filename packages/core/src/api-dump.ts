import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Roblox publishes a machine-readable API dump for every Studio deploy. Resolving
// the CURRENT Studio version through clientsettings and fetching that version's
// dump keeps get_class_info exactly in sync with the engine the user is running —
// unlike in-engine reflection, which plugins cannot use for member enumeration
// (ReflectionService member getters require the RobloxScript capability).
const CLIENT_VERSION_URL = 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsStudio64';

// Sanity floor: the real dump describes ~900 classes. A tiny Classes array means
// we fetched an error payload rather than the dump.
const MIN_DUMP_CLASSES = 100;

interface DumpType {
  Category: string;
  Name: string;
}

interface DumpParameter {
  Name: string;
  Type: DumpType;
  Default?: string;
}

interface DumpMember {
  MemberType: 'Property' | 'Function' | 'Event' | 'Callback';
  Name: string;
  Security: string | { Read: string; Write: string };
  Tags?: unknown[];
  ThreadSafety?: string;
  ValueType?: DumpType;
  Parameters?: DumpParameter[];
  ReturnType?: DumpType | DumpType[];
}

interface DumpClass {
  Name: string;
  Superclass: string;
  MemoryCategory?: string;
  Tags?: unknown[];
  Members: DumpMember[];
}

interface ApiDump {
  Classes: DumpClass[];
  Enums: unknown[];
  Version: number;
}

export interface ApiDumpDeps {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
}

interface ResolvedDump {
  version: string;
  classIndex: Map<string, DumpClass>;
  subclassIndex: Map<string, string[]>;
}

let resolved: ResolvedDump | undefined;

export function getApiDumpCacheDir(): string {
  return path.join(os.homedir(), '.robloxstudio-mcp');
}

// Test-only hook so unit tests start from a clean in-memory state.
export function _clearApiDumpCache(): void {
  resolved = undefined;
}

function buildIndexes(dump: ApiDump, version: string): ResolvedDump {
  const classIndex = new Map<string, DumpClass>();
  const subclassIndex = new Map<string, string[]>();
  for (const cls of dump.Classes) {
    classIndex.set(cls.Name, cls);
  }
  for (const cls of dump.Classes) {
    if (classIndex.has(cls.Superclass)) {
      const siblings = subclassIndex.get(cls.Superclass) ?? [];
      siblings.push(cls.Name);
      subclassIndex.set(cls.Superclass, siblings);
    }
  }
  return { version, classIndex, subclassIndex };
}

async function fetchDump(deps: ApiDumpDeps): Promise<{ dump: ApiDump; version: string }> {
  const cacheDir = deps.cacheDir ?? getApiDumpCacheDir();
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const versionResponse = await fetchImpl(CLIENT_VERSION_URL);
    if (!versionResponse.ok) {
      throw new Error(`client-version request failed with HTTP ${versionResponse.status}`);
    }
    const versionInfo = (await versionResponse.json()) as { version: string; clientVersionUpload: string };

    const cachePath = path.join(cacheDir, `api-dump-${versionInfo.version}.json`);
    if (fs.existsSync(cachePath)) {
      const dump = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as ApiDump;
      return { dump, version: versionInfo.version };
    }

    const dumpResponse = await fetchImpl(`https://setup.rbxcdn.com/${versionInfo.clientVersionUpload}-API-Dump.json`);
    if (!dumpResponse.ok) {
      throw new Error(`API dump request failed with HTTP ${dumpResponse.status}`);
    }
    const text = await dumpResponse.text();
    const dump = JSON.parse(text) as ApiDump;
    if (!Array.isArray(dump.Classes) || dump.Classes.length < MIN_DUMP_CLASSES) {
      throw new Error(`API dump malformed (${Array.isArray(dump.Classes) ? dump.Classes.length : 0} classes)`);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, text);
    console.error(`Downloaded Roblox API dump for Studio ${versionInfo.version} (${dump.Classes.length} classes)`);
    return { dump, version: versionInfo.version };
  } catch (error) {
    // Offline fallback: newest previously cached dump, even if version-stale.
    if (fs.existsSync(cacheDir)) {
      const candidates = fs
        .readdirSync(cacheDir)
        .filter(f => /^api-dump-.+\.json$/.test(f))
        .map(f => ({ file: f, mtime: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates.length > 0) {
        const file = candidates[0].file;
        const dump = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf-8')) as ApiDump;
        const version = file.replace(/^api-dump-/, '').replace(/\.json$/, '');
        return { dump, version };
      }
    }
    throw new Error(`Unable to obtain Roblox API dump: ${(error as Error).message}`);
  }
}

async function getResolvedDump(deps: ApiDumpDeps): Promise<ResolvedDump> {
  if (resolved) {
    return resolved;
  }
  const { dump, version } = await fetchDump(deps);
  resolved = buildIndexes(dump, version);
  return resolved;
}

function stringTags(tags?: unknown[]): string[] {
  if (!tags) return [];
  return tags.filter((t): t is string => typeof t === 'string');
}

function formatType(t?: DumpType): string {
  if (!t) return 'void';
  if (t.Category === 'Enum') return `Enum.${t.Name}`;
  return t.Name;
}

function formatParameters(params?: DumpParameter[]): string {
  if (!params || params.length === 0) return '()';
  const parts = params.map(p => {
    const base = `${p.Name}: ${formatType(p.Type)}`;
    return p.Default !== undefined ? `${base} = ${p.Default}` : base;
  });
  return `(${parts.join(', ')})`;
}

function formatReturn(rt?: DumpType | DumpType[]): string {
  if (Array.isArray(rt)) return rt.map(formatType).join(', ');
  return formatType(rt);
}

// 'None' is omitted entirely so agent-facing output only flags restricted members.
function formatSecurity(security: DumpMember['Security']): string | undefined {
  if (typeof security === 'string') {
    return security === 'None' ? undefined : security;
  }
  if (security.Read === security.Write) {
    return security.Read === 'None' ? undefined : security.Read;
  }
  return `read: ${security.Read}, write: ${security.Write}`;
}

interface MemberInfoBase {
  name: string;
  security?: string;
  tags?: string[];
  inheritedFrom?: string;
}

interface PropertyInfo extends MemberInfoBase {
  valueType: string;
}

interface SignatureInfo extends MemberInfoBase {
  signature: string;
}

export interface ClassInfo {
  className: string;
  superclassChain: string[];
  tags: string[];
  memoryCategory?: string;
  apiDumpVersion: string;
  subclasses: string[];
  properties: PropertyInfo[];
  methods: SignatureInfo[];
  events: SignatureInfo[];
  callbacks: SignatureInfo[];
}

/**
 * Resolve full class API info (members with types, security, and inheritance)
 * from the version-matched official API dump. Returns null when the class does
 * not exist in the dump — a definitive answer, unlike infrastructure failures,
 * which throw so callers can fall back.
 */
export async function getClassInfoFromDump(className: string, deps: ApiDumpDeps = {}): Promise<ClassInfo | null> {
  const { classIndex, subclassIndex, version } = await getResolvedDump(deps);

  const cls = classIndex.get(className);
  if (!cls) {
    return null;
  }

  const superclassChain: string[] = [];
  const properties: PropertyInfo[] = [];
  const methods: SignatureInfo[] = [];
  const events: SignatureInfo[] = [];
  const callbacks: SignatureInfo[] = [];
  const seen = new Set<string>();

  let current: DumpClass | undefined = cls;
  while (current) {
    const inheritedFrom = current === cls ? undefined : current.Name;
    for (const member of current.Members) {
      // Most-derived declaration wins when a name repeats along the chain.
      const key = `${member.MemberType}:${member.Name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const base: MemberInfoBase = { name: member.Name };
      const security = formatSecurity(member.Security);
      if (security) base.security = security;
      const tags = stringTags(member.Tags);
      if (tags.length > 0) base.tags = tags;
      if (inheritedFrom) base.inheritedFrom = inheritedFrom;

      switch (member.MemberType) {
        case 'Property':
          properties.push({ ...base, valueType: formatType(member.ValueType) });
          break;
        case 'Function':
          methods.push({ ...base, signature: `${member.Name}${formatParameters(member.Parameters)} -> ${formatReturn(member.ReturnType)}` });
          break;
        case 'Event':
          events.push({ ...base, signature: formatParameters(member.Parameters) });
          break;
        case 'Callback':
          callbacks.push({ ...base, signature: `${member.Name}${formatParameters(member.Parameters)} -> ${formatReturn(member.ReturnType)}` });
          break;
      }
    }
    const superclass: DumpClass | undefined = classIndex.get(current.Superclass);
    if (superclass) {
      superclassChain.push(superclass.Name);
    }
    current = superclass;
  }

  const info: ClassInfo = {
    className: cls.Name,
    superclassChain,
    tags: stringTags(cls.Tags),
    apiDumpVersion: version,
    subclasses: subclassIndex.get(cls.Name) ?? [],
    properties,
    methods,
    events,
    callbacks,
  };
  if (cls.MemoryCategory) {
    info.memoryCategory = cls.MemoryCategory;
  }
  return info;
}
