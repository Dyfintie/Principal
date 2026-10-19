import { Box, Text } from 'ink';
import { usageTools } from '../../../unified-inventory.js';
import type { UsageLine } from '../../../usage-view.js';
import { fit } from '../text.js';
export function UsageTab({
  tool,
  lines,
  start,
  page,
  width,
}: {
  tool: number;
  lines: UsageLine[];
  start: number;
  page: number;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {usageTools
            .map((t, i) => (i === tool ? `[${t.label}]` : ` ${t.label} `))
            .join('  ')}
        </Text>
      </Box>
      <Box flexDirection="column">
        {lines.slice(start, start + page).map((line, i) => (
          <Text key={i} color={line.color}>
            {fit(line.text, width)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
