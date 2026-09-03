import * as fs from 'fs';
import * as path from 'path';

// Every endpoint the server sends to the Studio plugin must have a route in the
// plugin, and every route must point at a function its handler module exports.
// An upstream merge once replaced the plugin's route table and silently turned
// twenty advertised tools into "Unknown endpoint" errors.

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function read(relative: string): string {
  return fs.readFileSync(path.join(repositoryRoot(), relative), 'utf8');
}

const serverSource = read('packages/core/src/tools/index.ts');
const communicationSource = read('studio-plugin/src/modules/Communication.ts');

function serverEndpoints(): string[] {
  const endpoints = new Set<string>();
  for (const match of serverSource.matchAll(/(?:_callSingle|_callFanout|request)\(\s*'(\/api\/[a-z0-9-]+)'/g)) {
    endpoints.add(match[1]);
  }
  return [...endpoints].sort();
}

function pluginRoutes(): Map<string, { module: string; handler: string }> {
  const routes = new Map<string, { module: string; handler: string }>();
  for (const match of communicationSource.matchAll(/"(\/api\/[a-z0-9-]+)"\s*:\s*([A-Za-z]+)\.([A-Za-z]+)/g)) {
    routes.set(match[1], { module: match[2], handler: match[3] });
  }
  return routes;
}

function handlerModulePath(moduleName: string): string | undefined {
  const match = communicationSource.match(new RegExp(`import ${moduleName} from "\\./([^"]+)";`));
  return match ? `studio-plugin/src/modules/${match[1]}.ts` : undefined;
}

describe('Studio plugin routes', () => {
  test('every endpoint the server calls has a plugin route', () => {
    const routes = pluginRoutes();
    const missing = serverEndpoints().filter((endpoint) => !routes.has(endpoint));
    expect(missing).toEqual([]);
  });

  test('every plugin route points at an exported handler function', () => {
    const broken: string[] = [];
    for (const [endpoint, { module, handler }] of pluginRoutes()) {
      const modulePath = handlerModulePath(module);
      if (!modulePath) {
        broken.push(`${endpoint}: ${module} is not imported`);
        continue;
      }
      const source = read(modulePath);
      const exportBlock = source.match(/export = \{([\s\S]*?)\};/)?.[1] ?? '';
      // Shorthand (`name,`) or aliased (`name: impl,`) export entries both count.
      const exported = new RegExp(`(^|[\\s,])${handler}\\s*(?:[,:]|$)`).test(exportBlock);
      if (!exported) {
        broken.push(`${endpoint}: ${module}.${handler} is not exported`);
      }
    }
    expect(broken).toEqual([]);
  });
});
