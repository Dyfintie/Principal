import { Box, Text } from 'ink';
import { fit } from '../text.js';
export type TextViewerState = { title: string; lines: string[]; offset: number };
export function TextViewer({
  viewer,
  width,
  height,
}: {
  viewer: TextViewerState;
  width: number;
  height: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {fit(viewer.title, width - 6)}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {viewer.lines
          .slice(viewer.offset, viewer.offset + Math.max(1, height - 9))
          .map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
      </Box>
      <Text dimColor>↑↓ scroll · Enter / Esc back</Text>
    </Box>
  );
}
