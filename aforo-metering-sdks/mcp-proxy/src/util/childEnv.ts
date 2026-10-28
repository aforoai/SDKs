/**
 * @file The environment a stdio child MCP server is started with (G301).
 *
 * The child is often a third-party package run with `npx -y`. It must not see
 * the proxy's Aforo API key or anything else the operator did not mean to hand
 * it, so it starts from a short allowlist of the proxy's own variables (what a
 * program needs to find binaries, its home directory, locale and temp space),
 * plus the names the operator lists in `passEnv`, plus the explicit `env`
 * entries. Every `AFORO_*` variable is withheld, whatever its source.
 */

/** Variables every child inherits, when the proxy has them. */
export const BASE_CHILD_ENV: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  // Windows
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramData', 'PROGRAMFILES', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  // Node / npx need these to find a registry and cache when the operator set them.
  'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_CACHE', 'npm_config_cache', 'NPM_CONFIG_REGISTRY', 'npm_config_registry',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  // Proxies the child needs to reach its own upstreams.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

const WITHHELD_PREFIX = /^AFORO_/i;

export interface ChildEnvResult {
  env: Record<string, string>;
  /** AFORO_* names that were asked for (passEnv or env) and withheld. */
  withheld: string[];
}

export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  explicit: Record<string, string> | undefined,
  passEnv: readonly string[] | undefined,
): ChildEnvResult {
  const env: Record<string, string> = {};
  const withheld: string[] = [];
  const inherit = (name: string) => {
    if (WITHHELD_PREFIX.test(name)) {
      withheld.push(name);
      return;
    }
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  };

  for (const name of BASE_CHILD_ENV) if (!WITHHELD_PREFIX.test(name)) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const name of Object.keys(parent)) {
    // Locale categories (LC_ALL, LC_CTYPE, ...) travel with LANG.
    if (/^LC_[A-Z_]+$/.test(name)) env[name] = parent[name] as string;
  }
  for (const raw of passEnv ?? []) {
    const name = raw.trim();
    if (name) inherit(name);
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (WITHHELD_PREFIX.test(name)) {
      withheld.push(name);
      continue;
    }
    env[name] = String(value);
  }
  return { env, withheld };
}
