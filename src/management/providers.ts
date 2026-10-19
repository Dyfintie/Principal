import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exec } from '../util.js';
import { Tool, type Capability, type Installation, type Profile } from './model.js';
import { isCompatibleVersion } from './compatibility.js';

const definitions = {
  codex: {
    binary: 'codex',
    version: '0.162.1',
    directory: '.codex',
    selector: 'CODEX_HOME',
    login: ['login'],
    resume: ['resume'],
    source: 'https://learn.chatgpt.com/docs/app-server',
  },
  claude: {
    binary: 'claude',
    version: '2.1.281',
    directory: '.claude',
    selector: 'CLAUDE_CONFIG_DIR',
    login: ['auth', 'login'],
    resume: ['--resume'],
    source: 'https://code.claude.com/docs/en/authentication',
  },
  copilot: {
    binary: 'copilot',
    version: '1.0.89',
    directory: '.copilot',
    selector: null,
    login: ['login'],
    resume: ['--resume'],
    source:
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli',
  },
  antigravity: {
    binary: 'agy',
    version: '1.3.3',
    directory: '.gemini/antigravity-cli',
    selector: null,
    login: [],
    resume: ['--conversation'],
    source: 'https://antigravity.google/docs/cli/statusline/',
  },
} as const;
export async function findExecutable(name: string): Promise<string | null> {
  const candidates = new Set<string>();
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory && path.isAbsolute(directory)) candidates.add(directory);
  }

  for (const directory of candidates) {
    const file = path.join(directory, name);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return await realpath(file);
    } catch {}
  }

  if (['agy', 'codex', 'claude', 'copilot'].includes(name)) {
    const fallbacks = [
      path.join(homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
    ];
    for (const directory of fallbacks) {
      const file = path.join(directory, name);
      try {
        await access(file, constants.X_OK);
        if ((await stat(file)).isFile()) return await realpath(file);
      } catch {}
    }
  }

  return null;
}
const capability = (supported: boolean, reason: string): Capability => ({
  supported,
  reason,
  confidence: supported ? 'verified-interface' : 'unverified',
});
/** Resolve the installed npm platform package without executing loader code. */
export async function copilotExecutables(executable: string): Promise<string[]> {
  const result = [executable];
  if (!executable.endsWith('/@github/copilot/npm-loader.js')) return result;
  const require = createRequire(executable);
  for (const platform of process.platform === 'linux'
    ? ['linux', 'linuxmusl']
    : [process.platform]) {
    try {
      const binary = await realpath(require.resolve(`@github/copilot-${platform}-${process.arch}`));
      await access(binary, constants.X_OK);
      if ((await stat(binary)).isFile()) result.push(binary);
    } catch {
      /* Optional platform package is absent. */
    }
  }
  return result;
}
export async function detectInstallation(tool: Tool): Promise<Installation> {
  const definition = definitions[tool];
  const executable = await findExecutable(definition.binary);
  let version: string | null = null;
  if (executable) {
    try {
      const result = await exec(executable, ['--version'], {
        timeout: 5000,
        maxBytes: 16_384,
        allowFailure: true,
      });
      version =
        (result ? result.stdout.toString() + result.stderr.toString() : '').match(
          /\b\d+\.\d+\.\d+\b/,
        )?.[0] ?? null;
    } catch {}
  }
  const knownVersion =
    version === definition.version ||
    (tool === 'codex' && (version === '0.162.1' || version === '0.163.0')) ||
    (tool === 'antigravity' && (version === '1.3.1' || version === '1.4.0')) ||
    (tool === 'copilot' && version === '1.0.95') ||
    (tool === 'claude' && version === '2.1.296');
  const verifiedVersion = knownVersion || isCompatibleVersion(version, definition.version);
  const verified = !!executable && verifiedVersion;
  const versionReason = verified
    ? knownVersion
      ? `Interface verified for ${version}; live authentication tests remain user-controlled`
      : `Compatible version family ${version} (baseline ${definition.version}); native response contracts are checked at runtime, live compatibility remains unverified`
    : `Requires verified ${definition.version}; installed ${version ?? 'unknown/unavailable'}`;
  let antigravityResume = false,
    antigravityContinue = false;
  if (tool === 'antigravity' && executable) {
    try {
      const help = await exec(executable, ['--help'], {
        timeout: 5000,
        maxBytes: 65_536,
        allowFailure: true,
      });
      antigravityContinue =
        help.code === 0 &&
        /^\s*--continue(?:\s|=|$)/m.test(help.stdout.toString() + help.stderr.toString());
      antigravityResume =
        help.code === 0 &&
        /^\s*--conversation(?:\s|=|$)/m.test(help.stdout.toString() + help.stderr.toString());
    } catch {
      /* An unavailable help probe disables resume, not login or observations. */
    }
  }
  const antigravityIsolation =
    tool === 'antigravity' &&
    process.platform === 'linux' &&
    (
      await Promise.all(
        ['dbus-daemon', 'gnome-keyring-daemon', 'gdbus', 'secret-tool'].map(findExecutable),
      )
    ).every(Boolean);
  const statuslineReason =
    'Documented statusline schema; account and quota fields are validated on each native callback, independently of the CLI version';
  const installation: Installation = {
    tool,
    executable,
    processExecutables:
      executable && tool === 'copilot'
        ? await copilotExecutables(executable)
        : undefined,
    version,
    verifiedVersion,
    source: definition.source,
    checkedAt: new Date().toISOString(),
    ...(tool === 'antigravity' ? { continueSupported: antigravityContinue } : {}),
    capabilities: {
      launch: capability(
        !!executable,
        executable
          ? 'Official native binary; permissions and sandbox defaults are preserved'
          : `Install ${definition.binary}`,
      ),
      configurationIsolation: {
        ...capability(
          !!executable &&
            (!!definition.selector || antigravityIsolation),
          tool === 'antigravity'
            ? antigravityIsolation
              ? 'Experimental Linux private HOME and D-Bus/keyring isolation; one native process per profile; real multi-account refresh remains untested'
              : 'Isolated login requires Linux, dbus-daemon, gnome-keyring-daemon, gdbus and secret-tool'
            : definition.selector
              ? `Official ${definition.selector} directory selector; credential-store independence is not established`
              : 'No validated independent credential namespace; use native account selection',
        ),
        ...(tool === 'antigravity' ? { confidence: 'unverified' as const } : {}),
      },
      independentAuthentication: capability(
        false,
        'Two-account authentication and natural token refresh have not been live-tested',
      ),
      resume:
        tool === 'antigravity'
          ? capability(
              antigravityResume,
              antigravityResume
                ? 'Installed CLI advertises --conversation in its help'
                : 'Resume unavailable: installed CLI help did not confirm --conversation; launch and sign-in remain available',
            )
          : capability(verified, versionReason),
      history: {
        ...capability(
          (verified && tool === 'codex') || (tool === 'antigravity' && !!executable),
          tool === 'antigravity'
            ? 'Experimental local SQLite history; every source/destination schema is checked, opaque payload and native continuation compatibility remain unverified'
            : tool === 'codex'
              ? versionReason
              : 'Use native resume picker; automatic history enumeration is not validated',
        ),
        ...(tool === 'antigravity' ? { confidence: 'unverified' as const } : {}),
      },
      resources: capability(
        verified && ['codex', 'copilot'].includes(tool),
        tool === 'codex'
          ? versionReason
          : tool === 'copilot'
            ? 'Official account.getQuota; fields depend on the current account and CLI version'
            : tool === 'antigravity'
              ? 'Usage arrives through validated native statusline callbacks; refresh does not poll this provider'
              : !verified
                ? versionReason
                : 'Usage arrives through optional native statusline callbacks; refresh does not poll this provider',
      ),
      observer:
        tool === 'antigravity'
          ? {
              supported: !!executable,
              confidence: 'unverified',
              reason: executable
                ? statuslineReason
                : 'Install agy to receive native statusline updates',
            }
          : capability(verified && tool === 'claude', versionReason),
    },
  };
  if (!knownVersion)
    for (const cap of Object.values(installation.capabilities)) cap.confidence = 'unverified';
  return installation;
}
export async function detectInstallations() {
  return Promise.all(Tool.options.map(detectInstallation));
}
export function defaultDirectory(tool: Tool) {
  const selector = definitions[tool].selector;
  if (tool === 'copilot' && process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  if (tool === 'antigravity' && process.env.ANTIGRAVITY_HOME) return path.resolve(process.env.ANTIGRAVITY_HOME);
  return path.resolve(
    (selector && process.env[selector]) || path.join(homedir(), definitions[tool].directory),
  );
}
export function profileEnvironment(
  profile: Profile,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const selector = definitions[profile.tool].selector;
  if (selector) env[selector] = profile.directory;
  return env;
}
export function authenticationConflicts(profile: Profile, env: NodeJS.ProcessEnv = process.env) {
  const names: Record<Tool, string[]> = {
    codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
    claude: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ],
    copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    antigravity: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
  };
  const conflicts = names[profile.tool].filter((name) => !!env[name]);
  return conflicts;
}
export function nativeExecutable(installation: Installation) {
  return installation.tool === 'copilot'
    ? (installation.processExecutables?.find((p) => !p.endsWith('.js')) ?? installation.executable)
    : installation.executable;
}
export function buildNativeLaunch(
  profile: Profile,
  installation: Installation,
  args: string[],
  nativeId?: string,
) {
  if (!installation.executable) throw new Error(`Install ${profile.tool} before launching`);
  if (nativeId && !installation.capabilities.resume.supported)
    throw new Error(installation.capabilities.resume.reason);
  return {
    executable: nativeExecutable(installation)!,
    args: [
      // A shared Codex daemon owns its own authentication state. Load the
      // selected CODEX_HOME in this process rather than reusing that state.
      ...(profile.tool === 'codex' && installation.verifiedVersion && !args.includes('--no-daemon')
        ? ['--no-daemon']
        : []),
      ...(nativeId ? [...definitions[profile.tool].resume, nativeId, ...args] : args),
    ],
    env: profileEnvironment(profile),
  };
}
export function buildLoginLaunch(profile: Profile, installation: Installation, deviceAuth = false) {
  if (!installation.executable) throw new Error(`Install ${profile.tool} before signing in`);
  if (deviceAuth && (profile.tool !== 'codex' || !installation.verifiedVersion))
    throw new Error('Device-code sign-in requires a supported Codex installation');
  return {
    executable: nativeExecutable(installation)!,
    args: [
      ...definitions[profile.tool].login,
      ...(deviceAuth ? ['--device-auth'] : []),
    ],
    env: profileEnvironment(profile),
  };
}
