// Test-only transport harness for synthetic integration fixtures.
// Not installed as a CLI; the public Principal entrypoint is TUI-only.
import { Command } from 'commander';
import { managementDoctor, registerManagementCommands } from '../dist/management/commands.js';
const program = new Command().enablePositionalOptions().option('--json');
registerManagementCommands(program, {
  runNative: async (operation) => {
    const code = await operation();
    if (typeof code === 'number') process.exitCode = code;
  },
});
program
  .command('doctor')
  .option('--json')
  .action((_options, command) => managementDoctor(command));
try {
  await program.parseAsync();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
