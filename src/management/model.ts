import { z } from 'zod';

export const Tool = z.enum(['codex', 'claude', 'copilot', 'antigravity']);
export type Tool = z.infer<typeof Tool>;

export const TOOL_ALIASES: Record<string, Tool> = {
  antigravity: 'antigravity',
  agy: 'antigravity',
  codex: 'codex',
  cdx: 'codex',
  claude: 'claude',
  cld: 'claude',
  copilot: 'copilot',
  cop: 'copilot',
};

export function normalizeTool(input: string | undefined | null): Tool | null {
  if (!input) return null;
  const lower = input.toLowerCase().trim();
  return TOOL_ALIASES[lower] ?? null;
}
export const Label = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'Control characters are not allowed');
export function parseProfileLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Enter a profile name, such as Personal or Other.');
  const parsed = Label.safeParse(value);
  if (!parsed.success)
    throw new Error('Profile names must be 1–160 characters without control characters.');
  return parsed.data;
}
export const Identifier = z.string().min(1).max(512);
export const NativeId = z
  .string()
  .regex(/^[a-zA-Z0-9_.:-]{1,160}$/, 'Invalid native conversation ID');
export interface Capability {
  supported: boolean;
  reason: string;
  confidence: 'verified-interface' | 'unverified';
}
export interface Installation {
  continueSupported?: boolean;
  tool: Tool;
  executable: string | null;
  processExecutables?: string[];
  version: string | null;
  verifiedVersion: boolean;
  capabilities: Record<
    | 'launch'
    | 'configurationIsolation'
    | 'independentAuthentication'
    | 'resume'
    | 'history'
    | 'resources'
    | 'observer',
    Capability
  >;
  source: string;
  checkedAt: string;
}
export interface HandoffConstraints {
  timeLimitHours?: number;
  expiresAt?: string;
  quotaLimitPercent?: number;
  baselineQuotaRemaining?: number;
  allowedQuotaFloor?: number;
  exportedAt?: string;
  importedAt?: string;
  status?: 'active' | 'time-expired' | 'quota-exhausted';
  reason?: string;
}

export interface Profile {
  observationError?: {
    category: 'authentication' | 'network' | 'rate-limit' | 'permission' | 'rpc';
    reason: string;
    observedAt: string;
    retryAt?: string;
    code?: number;
    status?: number;
  } | null;
  observationWarnings?: string[];
  removedAt?: string | null;
  id: string;
  tool: Tool;
  label: string;
  directory: string;
  isolated: boolean;
  sharedHistory?: boolean;
  handoffConstraints?: HandoffConstraints;
  createdAt: string;
  auth: 'unknown' | 'authenticated' | 'unauthenticated';
  authObservedAt: string | null;
  reportedAccount: string | null;
  plan: string | null;
}
export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  order: number;
}
export interface Project {
  id: string;
  environmentId: string;
  directory: string;
  name: string;
}
export interface SessionEntry {
  id: string;
  folderId: string;
  projectId: string;
  profileId: string | null;
  tool: Tool;
  title: string;
  createdAt: string;
  archivedAt: string | null;
  conversationId: string | null;
}
export interface ProcessIdentity {
  pid: number;
  startTime: string;
  bootId: string;
}
export interface Invocation {
  terminal?: { kind: 'tmux'; socket: string; session: string };
  hasControllingTerminal?: boolean | null;
  id: string;
  entryId: string;
  profileId: string | null;
  identity: ProcessIdentity | null;
  owned: boolean;
  wrapper: ProcessIdentity | null;
  runtimeIdentity?: ProcessIdentity;
  startedAt: string;
  endedAt: string | null;
  lifecycle: 'starting' | 'running' | 'exited' | 'unknown';
  activity: 'working' | 'awaiting-user' | 'idle' | 'unknown';
  connection: 'connected' | 'stale' | 'disconnected';
  observedAt: string;
  exitCode: number | null;
  reportedAccount: string | null;
  stopRequestedAt?: string | null;
  reportedDirectory?: string | null;
  activitySource?: string | null;
}
export interface Conversation {
  nativeResumeVerified?: boolean;
  seededFrom?: { directory: string; nativeId: string };
  id: string;
  profileId: string | null;
  tool: Tool;
  nativeId: string;
  projectId: string;
}
export interface Binding {
  invocationId: string;
  conversationId: string;
  startedAt: string;
  endedAt: string | null;
  evidence: 'launch-request' | 'native-callback';
}
export interface ResourceObservation {
  id: string;
  profileId: string | null;
  invocationId: string | null;
  account: string | null;
  metric: 'rate-limit-used' | 'quota-remaining' | 'tokens-used' | 'api-expenditure';
  bucket: string;
  value: number;
  unit: 'percent' | 'tokens' | 'USD';
  resetsAt: string | null;
  source: string;
  sourceKind: 'official' | 'local' | 'estimated';
  quota?: { used?: number; allowance?: number; unlimited?: boolean };
  observedAt: string;
}
export interface ManagementEvent {
  seq: number;
  at: string;
  type: string;
  entityId: string;
}
export interface Snapshot {
  protocolVersion: 1;
  seq: number;
  environment: { id: string; platform: string; name: string };
  installations: Installation[];
  profiles: Profile[];
  activeProfiles?: Record<string, string>;
  excludedProfiles?: { tool: Tool; directory: string }[];
  dismissedAccountIds?: string[];
  folders: Folder[];
  projects: Project[];
  entries: SessionEntry[];
  invocations: Invocation[];
  conversations: Conversation[];
  bindings: Binding[];
  resources: ResourceObservation[];
  ui: { expanded: string[]; selected: string | null };
}
export const Callback = z.object({
  warnings: z.array(Label).max(8).optional(),
  invocationId: z.string().uuid().optional(),
  tool: Tool,
  ancestorPids: z.array(z.number().int().positive()).max(8),
  conversationId: NativeId.optional(),
  cwd: z.string().max(4096).optional(),
  activity: z.enum(['working', 'awaiting-user', 'idle', 'unknown']).optional(),
  activitySource: Label.optional(),
  account: Label.optional(),
  resources: z
    .array(
      z
        .object({
          metric: z.enum(['rate-limit-used', 'quota-remaining', 'tokens-used', 'api-expenditure']),
          bucket: Label,
          value: z.number().finite().nonnegative(),
          unit: z.enum(['percent', 'tokens', 'USD']),
          resetsAt: z.string().datetime().nullable(),
          source: z.string().max(200),
          sourceKind: z.enum(['official', 'local', 'estimated']),
        })
        .refine((r) => r.unit !== 'percent' || r.value <= 100, 'Percentage exceeds 100'),
    )
    .max(30),
});
export type Callback = z.infer<typeof Callback>;
export function freshness(observedAt: string, now = Date.now()) {
  return now - Date.parse(observedAt) > 300_000 ? 'stale' : 'cached';
}
