import { Box, Text } from 'ink';
import { fit } from '../text.js';
export type Field = { label: string; value: string; choices?: string[] };
export type Dialog = {
  title: string;
  description?: string[];
  fields: Field[];
  index: number;
  submit: (values: string[]) => Promise<void>;
};
export function FormDialog({ dialog, width }: { dialog: Dialog; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {fit(dialog.title, width - 6)}
      </Text>
      {dialog.description?.map((line, i) => (
        <Text key={i} color="gray">
          {fit(line, width - 6)}
        </Text>
      ))}
      <Box flexDirection="column" marginY={dialog.description?.length ? 1 : 0}>
        {dialog.fields.map((field, i) => {
          const isFocused = i === dialog.index;
          return (
            <Text key={field.label} color={isFocused ? 'cyan' : undefined} bold={isFocused}>
              {fit(
                `${isFocused ? '❯ ' : '  '}${field.label}: ${field.choices ? '‹ ' : ''}${field.value}${field.choices ? ' ›' : isFocused ? '▎' : ''}`,
                width - 6,
              )}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>
        {dialog.fields.length
          ? 'Tab selects field · ←→ choose · Ctrl+U clears · Enter submits · Esc cancels'
          : 'Enter confirms · Esc cancels'}
      </Text>
    </Box>
  );
}
