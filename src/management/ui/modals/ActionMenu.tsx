import { Box, Text } from 'ink';
import { fit } from '../text.js';
export type ActionMenuState = {
  title: string;
  items: { label: string; key: string }[];
  index: number;
};
export function ActionMenu({
  menu,
  width,
  height,
}: {
  menu: ActionMenuState;
  width: number;
  height: number;
}) {
  const page = Math.max(1, height - 9);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {menu.title}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {menu.items
          .slice(Math.max(0, menu.index - page + 1), Math.max(page, menu.index + 1))
          .map((item) => {
            const isSelected = item === menu.items[menu.index];
            return (
              <Text key={item.key} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {fit(`${isSelected ? '❯' : ' '} ${item.label}`, width - 6)}
              </Text>
            );
          })}
      </Box>
      <Text dimColor>↑↓ choose · Enter select · Esc back</Text>
    </Box>
  );
}
