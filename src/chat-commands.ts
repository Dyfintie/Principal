export const chatCommands = [
  {
    name: '/usage',
    args: '[--refresh]',
    description: 'Usage across native profiles and enrolled accounts',
  },
  {
    name: '/accounts',
    args: '[list|add|reauth|remove|model ...]',
    description: 'Discover existing profiles and inspect account identity',
  },
  {
    name: '/sessions',
    args: '[--saved]',
    description: 'Open the folder tree; --saved lists Principal conversations',
  },
  {
    name: '/dashboard',
    args: '[runs [ID]]',
    description: 'Open native management or orchestration monitoring',
  },
  {
    name: '/profiles',
    args: '[add|list|inspect|login|observer ...]',
    description: 'Native account setup, login, launch and history menus',
  },
  { name: '/codex', args: '', description: 'Open existing native profile setup' },
  { name: '/antigravity', args: '', description: 'Open existing native profile setup' },
  { name: '/login', args: 'PROFILE', description: 'Sign in through the official native tool' },
  {
    name: '/inspect',
    args: 'PROFILE',
    description: 'Check supported native authentication metadata',
  },
  {
    name: '/launch',
    args: '--profile PROFILE [options] -- [native arguments]',
    description: 'Launch an official agent; /profiles offers a form',
  },
  {
    name: '/agents',
    args: '[list|resume|stop|history|rename|move|archive ...]',
    description: 'Native session tree and process management',
  },
  {
    name: '/folders',
    args: 'list|create|rename|move|order|delete ...',
    description: 'Organize virtual session folders',
  },
  { name: '/resources', args: '[--refresh]', description: 'Alias for /usage' },
  {
    name: '/doctor',
    args: '[--legacy]',
    description: 'Native diagnostics or optional runtime prerequisites',
  },
  {
    name: '/enroll',
    args: 'codex|antigravity [LABEL]',
    description: 'Enroll an isolated Principal account for project conversations',
  },
  {
    name: '/native',
    args: '',
    description: 'Open the selected conversation account’s native interface',
  },
  { name: '/exec', args: 'TEXT', description: 'Submit project work in the current conversation' },
  {
    name: '/mode',
    args: '[native|principal]',
    description: 'Switch the project conversation to its native interface',
  },
  { name: '/pool', args: '[NAME]', description: 'Show or select an account pool' },
  { name: '/pools', args: 'list|create ...', description: 'Manage orchestration account pools' },
  { name: '/model', args: '[ID]', description: 'Show or select a conversation model' },
  {
    name: '/models',
    args: '--account LABEL',
    description: 'List models supported by an enrolled account',
  },
  { name: '/lead', args: 'ACCOUNT [confirm]', description: 'Change the lead account' },
  { name: '/workers', args: '[SESSION_ID]', description: 'Inspect delegated project agents' },
  { name: '/history', args: '', description: 'Show the current project conversation' },
  {
    name: '/conversations',
    args: 'list|history|prune ...',
    description: 'Manage saved Principal conversations',
  },
  { name: '/context', args: '', description: 'Inspect conversation context' },
  { name: '/compact', args: '', description: 'Compact conversation context' },
  { name: '/review', args: '', description: 'Review proposed conversation changes' },
  { name: '/apply', args: '', description: 'Apply reviewed conversation changes' },
  { name: '/refresh', args: '', description: 'Refresh the conversation working area' },
  {
    name: '/stop',
    args: '[INVOCATION]',
    description: 'Interrupt project work or stop a verified owned native invocation',
  },
  {
    name: '/resume',
    args: 'SESSION_ID',
    description: 'Resume a native entry or Principal conversation',
  },
  { name: '/answer', args: 'ID TEXT', description: 'Answer a pending project question' },
  { name: '/project', args: 'PATH', description: 'Select a project; previous work stays intact' },
  {
    name: '/plan',
    args: 'GOAL [options]',
    description: 'Create a reviewable task graph; consumes inference quota',
  },
  {
    name: '/run',
    args: '[GOAL] [--tasks FILE]',
    description: 'Start orchestration work; consumes inference quota',
  },
  { name: '/status', args: '[RUN_ID]', description: 'Inspect task runs' },
  { name: '/logs', args: 'RUN_ID', description: 'Show current run logs' },
  { name: '/cancel', args: 'RUN_ID', description: 'Cancel a task run' },
  {
    name: '/integrate',
    args: 'RUN_ID [--base REF]',
    description: 'Integrate run changes for review',
  },
  { name: '/prune', args: 'RUN_ID', description: 'Prune a completed run' },
  {
    name: '/tasks',
    args: 'review|apply|resume RUN_ID [options]',
    description: 'Review, apply or resume task runs',
  },
  { name: '/init', args: '', description: 'Create project configuration' },
  {
    name: '/runtime',
    args: 'build [options]',
    description: 'Build the optional isolated execution runtime',
  },
  { name: '/back', args: '', description: 'Return to the conversation prompt' },
  { name: '/help', args: '', description: 'Show command help' },
  { name: '/exit', args: '', description: 'Close the TUI without stopping other work' },
];
export function commandSuggestions(draft: string) {
  if (!/^\/[^\s]*$/.test(draft)) return [];
  return chatCommands.filter((command) => command.name.startsWith(draft));
}
