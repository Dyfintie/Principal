import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable } from './providers.js';

export interface ParsedConversation {
  id: string;
  cwd: string;
  userTurns: string[];
  assistantTurns: string[];
  commandsRun: { cmd: string; output?: string; failed?: boolean }[];
  filesTouched: string[];
  lastAssistantResponse: string;
  lastError?: string;
  totalTurns: number;
}

export interface ContextHandoffResult {
  handoffMarkdown: string;
  summaryPrompt: string;
  filesModified: string[];
  targetDirectory: string;
  title: string;
  nativeId: string;
}

/** Strips internal system boilerplate and context tags from user prompts. */
export function stripBoilerplate(text: string): string {
  if (!text) return '';
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, '')
    .replace(/<multi_agent_role>[\s\S]*?<\/multi_agent_role>/gi, '')
    .replace(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/gi, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, '')
    .trim();
}

/** Parses Codex JSONL rollout records into structured conversation context. */
export function parseCodexRollout(records: any[]): ParsedConversation {
  let id = 'unknown';
  let cwd = process.cwd();
  const userTurns: string[] = [];
  const assistantTurns: string[] = [];
  const commandsRun: { cmd: string; output?: string; failed?: boolean }[] = [];
  const filesTouchedSet = new Set<string>();
  let lastAssistantResponse = '';
  let lastError: string | undefined;

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    if (record.type === 'session_meta') {
      if (record.payload?.id) id = String(record.payload.id);
      if (record.payload?.cwd) cwd = String(record.payload.cwd);
    } else if (record.type === 'turn_context') {
      if (record.payload?.cwd) cwd = String(record.payload.cwd);
    } else if (record.type === 'response_item') {
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') continue;

      if (payload.type === 'message') {
        const role = payload.role;
        let text = '';
        if (typeof payload.content === 'string') {
          text = payload.content;
        } else if (Array.isArray(payload.content)) {
          text = payload.content
            .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
            .filter(Boolean)
            .join('\n');
        }

        if (role === 'user') {
          const cleaned = stripBoilerplate(text);
          if (cleaned) userTurns.push(cleaned);
        } else if (role === 'assistant') {
          const cleaned = text.trim();
          if (cleaned) {
            assistantTurns.push(cleaned);
            lastAssistantResponse = cleaned;
          }
        }
      } else if (payload.type === 'function_call') {
        const name = payload.name;
        let args: any = payload.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {}
        }

        if (name === 'exec_command' || name === 'bash' || name === 'execute') {
          const cmd = args?.cmd || args?.command || (typeof args === 'string' ? args : '');
          if (cmd) commandsRun.push({ cmd });
        } else if (name === 'edit_file' || name === 'apply_patch' || name === 'write_to_file' || name === 'create_file') {
          const target = args?.path || args?.file || args?.TargetFile;
          if (typeof target === 'string') filesTouchedSet.add(target);
        } else if (name === 'view_file' || name === 'read_file') {
          const target = args?.path || args?.file || args?.AbsolutePath;
          if (typeof target === 'string') filesTouchedSet.add(target);
        }
      } else if (payload.type === 'function_call_output') {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
        if (commandsRun.length > 0) {
          const last = commandsRun[commandsRun.length - 1];
          if (!last.output) {
            last.output = output.slice(0, 1000);
            if (/error|failed|exit code [1-9]|exception|traceback/i.test(output)) {
              last.failed = true;
              lastError = output.slice(0, 500);
            }
          }
        }
      }
    }
  }

  return {
    id,
    cwd,
    userTurns,
    assistantTurns,
    commandsRun,
    filesTouched: Array.from(filesTouchedSet),
    lastAssistantResponse,
    lastError,
    totalTurns: userTurns.length,
  };
}

/** Synthesizes an LLM-optimized context handoff markdown document and compact prompt. */
export function synthesizeContextHandoff(
  parsed: ParsedConversation,
  meta?: { title?: string; targetTool?: string },
): ContextHandoffResult {
  const title = meta?.title || `Codex Session ${parsed.id.slice(0, 8)}`;
  const rawTarget = meta?.targetTool || 'Antigravity';
  const targetTool = rawTarget.charAt(0).toUpperCase() + rawTarget.slice(1);

  const userGoalsList = parsed.userTurns.length
    ? parsed.userTurns.map((u, i) => `${i + 1}. ${u}`).join('\n')
    : 'No explicit user request recorded.';

  const filesList = parsed.filesTouched.length
    ? parsed.filesTouched.map((f) => `- \`${f}\``).join('\n')
    : '*(No specific files recorded)*';

  const recentCommands = parsed.commandsRun.slice(-8);
  const commandsList = recentCommands.length
    ? recentCommands
        .map(
          (c) =>
            `- \`${c.cmd}\`${c.failed ? ' ❌ *(failed)*' : ' ✔'}`,
        )
        .join('\n')
    : '*(No commands executed)*';

  const lastStatus = parsed.lastAssistantResponse
    ? parsed.lastAssistantResponse.length > 1500
      ? parsed.lastAssistantResponse.slice(0, 1500) + '\n\n*(Truncated for summary)*'
      : parsed.lastAssistantResponse
    : 'Session ended or quota limit reached during processing.';

  const handoffMarkdown = `# 🔄 Context Handoff: Codex → ${targetTool}

**Original Session**: ${title}  
**Native Thread ID**: \`${parsed.id}\`  
**Working Directory**: \`${parsed.cwd}\`  
**Export Date**: ${new Date().toISOString()}  

---

## 🎯 Task Objective & User Requests
${userGoalsList}

---

## 🛠️ Files Touched & Modified
${filesList}

---

## 💻 Recent Commands Executed
${commandsList}

${parsed.lastError ? `### ⚠️ Last Recorded Error / Blocker\n\`\`\`\n${parsed.lastError}\n\`\`\`\n` : ''}
---

## 💬 State When Codex Stopped (Quota Limit Hit)
${lastStatus}

---

## 🚀 Recommended Immediate Actions for ${targetTool}
1. Review current workspace status and git diff in \`${parsed.cwd}\` (\`git status\`, \`git diff\`).
2. Verify existing changes and resolve any pending errors noted above.
3. Continue implementing the task objectives outlined in Section 1 without restarting from scratch.

---

<details>
<summary>📜 Raw User Prompt History (${parsed.userTurns.length} turns)</summary>

${parsed.userTurns.map((turn, i) => `### Turn ${i + 1}\n${turn}\n`).join('\n')}
</details>
`;

  // Generate a concise prompt (approx 200-300 words) suitable as an initial CLI prompt for agy
  const firstPrompt = parsed.userTurns[0] ? parsed.userTurns[0].slice(0, 200) : title;
  const recentSummary = parsed.lastAssistantResponse
    ? parsed.lastAssistantResponse.slice(0, 300).replace(/\n+/g, ' ')
    : 'Work in progress when Codex quota was reached.';

  const summaryPrompt = [
    `I am continuing a task originally started in Codex (which reached its quota limit).`,
    `Working directory: ${parsed.cwd}`,
    `Original goal: ${firstPrompt}`,
    parsed.filesTouched.length ? `Files modified: ${parsed.filesTouched.slice(0, 6).join(', ')}` : '',
    `Latest status: ${recentSummary}`,
    `Full context handoff has been saved to .principal/context-handoff-${parsed.id.slice(0, 8)}.md.`,
    `Please inspect the workspace, check git status, and proceed with the remaining work.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    handoffMarkdown,
    summaryPrompt,
    filesModified: parsed.filesTouched,
    targetDirectory: parsed.cwd,
    title,
    nativeId: parsed.id,
  };
}

/** Recursively search for a Codex rollout JSONL file matching the thread ID. */
export async function locateCodexRollout(
  profileDirectory: string,
  nativeId: string,
): Promise<string | null> {
  const searchDirs = [
    path.join(profileDirectory, 'sessions'),
    path.join(profileDirectory, 'archived_sessions'),
  ];

  for (const base of searchDirs) {
    try {
      const match = await findInDir(base, nativeId);
      if (match) return match;
    } catch {}
  }

  return null;
}

async function findInDir(dir: string, nativeId: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findInDir(fullPath, nativeId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (entry.name.includes(nativeId)) {
        return fullPath;
      }
    }
  }
  return null;
}

/** Safely read rollout file records from disk. */
export async function readRolloutRecords(filePath: string): Promise<any[]> {
  const content = await readFile(filePath, 'utf8');
  return content
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Saves the synthesized handoff markdown to a project file. */
export async function saveHandoffDocument(
  targetDir: string,
  nativeId: string,
  content: string,
  customPath?: string,
): Promise<string> {
  const filePath = customPath
    ? path.resolve(targetDir, customPath)
    : path.join(targetDir, '.principal', `context-handoff-${nativeId.slice(0, 8)}.md`);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

/** Copies text to system clipboard (Wayland wl-copy or X11 xclip). */
export async function copyToClipboard(text: string): Promise<boolean> {
  const binary = (await findExecutable('wl-copy')) || (await findExecutable('xclip'));
  if (!binary) return false;

  return new Promise((resolve) => {
    const child = spawn(
      binary,
      binary.endsWith('xclip') ? ['-selection', 'clipboard'] : [],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.stdin.write(text);
    child.stdin.end();
  });
}
