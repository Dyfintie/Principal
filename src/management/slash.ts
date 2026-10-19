export interface CommandItem {
  command: string;
  description: string;
}

export const managementCommands: readonly CommandItem[] = [
  { command: '/usage', description: 'Usage by tool · Tab switches providers (/u)' },
  { command: '/accounts', description: 'Existing accounts and authentication status' },
  { command: '/profiles', description: 'Accounts by provider · Tab switches · n sign in (/p)' },
  { command: '/launch', description: 'Launch native CLI or multi-profiles · /l [p1] [p2]...' },
  { command: '/swap', description: 'Hot swap active account · /swap [tool] [account] (/sw)' },
  { command: '/sessions', description: 'Folder-style session explorer (/s)' },
  { command: '/doctor', description: 'System health, tool verification & diagnostics (/d)' },
  { command: '/help', description: 'Management commands and shortcuts guide (/h)' },
  { command: '/exit', description: 'Close Principal (/q)' },
  { command: '/pull', description: 'Reopen the selected saved session on this terminal' },
  { command: '/diagnostics', description: 'Installed tools and integration status' },
  { command: '/agents', description: 'Manage native sessions · list, resume, stop' },
  { command: '/switch', description: 'Alias for /swap · Hot swap active account' },
  { command: '/folders', description: 'Organize sessions · list, create, move' },
  { command: '/warnings', description: 'Active warnings and errors · f2' },
  { command: '/export', description: 'Export session context to Antigravity · /export [id]' },
  { command: '/handoff', description: 'Share or import scoped account credentials · /handoff' },
  { command: '/back', description: 'Return to Sessions' },
] as const;

export function managementSuggestions(draft: string): readonly CommandItem[] {
  if (!draft.startsWith('/') || /\s/.test(draft)) return [];
  const lower = draft.toLowerCase();
  return managementCommands.filter((item) => item.command.startsWith(lower));
}
