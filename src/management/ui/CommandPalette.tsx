import { Box, Text } from 'ink';
import { managementSuggestions } from '../slash.js';
import { fit } from './text.js';
export function CommandPalette({
  suggestions,
  start,
  page,
  index,
  draft,
  width,
}: {
  suggestions: ReturnType<typeof managementSuggestions>;
  start: number;
  page: number;
  index: number;
  draft: string | null;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={suggestions.length ? 1 : 0}>
      {suggestions.slice(start, start + page).map((item, i) => {
        const isSelected = start + i === index;
        return (
          <Box key={item.command} paddingLeft={1}>
            <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
              {isSelected ? '❯' : ' '} {item.command.padEnd(16)}
            </Text>
            <Text color={isSelected ? 'white' : 'gray'}>
              {fit(item.description, Math.max(10, width - 20))}
            </Text>
          </Box>
        );
      })}
      <Box
        borderStyle="round"
        borderColor={draft !== null ? 'cyan' : 'gray'}
        paddingX={1}
      >
        <Text color={draft !== null ? 'cyan' : undefined} dimColor={draft === null}>
          {fit(
            draft !== null ? `❯ ${draft}▏` : '❯ type / for management commands',
            Math.max(10, width - 4),
          )}
        </Text>
      </Box>
    </Box>
  );
}
