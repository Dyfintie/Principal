import { Box, Text } from 'ink';
import type { Snapshot } from '../../model.js';
import type { TreeRow } from '../../tree.js';
import { fit } from '../text.js';
export function SessionsTab({
  archived,
  search,
  searching,
  rows,
  snapshot,
  row,
  start,
  page,
  wide,
  width,
  listWidth,
  detailLines,
}: {
  archived: boolean;
  search: string;
  searching: boolean;
  rows: TreeRow[];
  snapshot: Snapshot | null;
  row?: TreeRow;
  start: number;
  page: number;
  wide: boolean;
  width: number;
  listWidth: number;
  detailLines: string[];
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between" width={width}>
        <Text color="cyan" bold>
          {archived ? '📁 ARCHIVE EXPLORER' : '📂 SESSION EXPLORER'}
        </Text>
        {(search || searching) && (
          <Text color="yellow">
            🔍 Search: <Text bold>{search}</Text>
            {searching ? '▏' : ''}
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Box flexDirection="column" width={wide ? listWidth : undefined}>
          {!rows.length && (
            <Text dimColor>
              {snapshot
                ? 'No matching sessions. n launch · c create folder'
                : 'Discovering native tools…'}
            </Text>
          )}
          {rows.slice(start, start + page).map((item) => {
            const isSelected = item.id === row?.id;
            const indent = '  '.repeat(item.depth);
            const icon =
              item.kind === 'entry'
                ? '·'
                : item.expanded
                  ? '▾'
                  : '▸';
            const suffix =
              item.kind !== 'entry'
                ? ` (${item.count})${item.summary ? ` · ${item.summary}` : ''}`
                : ` · ${item.activity}`;
            const fullText = `${isSelected ? '›' : ' '} ${indent}${icon} ${item.label}${suffix}`;

            return (
              <Text key={item.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {fit(fullText, listWidth)}
              </Text>
            );
          })}
        </Box>
        {wide && (
          <Box
            flexDirection="column"
            width={width - listWidth}
            paddingLeft={2}
            borderStyle="single"
            borderColor="gray"
          >
            <Text bold color="cyan">
              SESSION DETAILS
            </Text>
            {detailLines.slice(0, Math.max(1, page - 1)).map((line, i) => (
              <Text key={i} color={i === 0 ? 'white' : 'gray'} bold={i === 0}>
                {fit(line, width - listWidth - 4)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {!wide && <Text dimColor>{fit(detailLines.slice(1, 4).join(' · '), width)}</Text>}
    </Box>
  );
}
