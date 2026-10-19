import { Box, Text } from 'ink';
import { usageTools, type ProfileInventoryRow } from '../../../unified-inventory.js';
import type { Profile, Snapshot } from '../../model.js';
import { fit } from '../text.js';
export function ProfilesTab({
  profileTool,
  selectedTool,
  profileRows,
  selectedProfileRow,
  profile,
  snapshot,
  listIndex,
  page,
  width,
}: {
  profileTool: number;
  selectedTool: (typeof usageTools)[number];
  profileRows: ProfileInventoryRow[];
  selectedProfileRow?: ProfileInventoryRow;
  profile?: Profile;
  snapshot: Snapshot | null;
  listIndex: number;
  page: number;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Provider Selector Tabs */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {usageTools
            .map((tool, i) =>
              i === profileTool ? `[${tool.label}]` : ` ${tool.label} `,
            )
            .join('  ')}
        </Text>
      </Box>

      <Box justifyContent="space-between" width={width}>
        <Text bold color="white">
          PROFILES · {selectedTool.label}
        </Text>
        <Text dimColor>
          {profileRows.length} account{profileRows.length === 1 ? '' : 's'} registered
        </Text>
      </Box>

      {!profileRows.length && (
        <Box marginTop={1}>
          <Text dimColor>No {selectedTool.label} accounts added. Press n to sign in.</Text>
        </Box>
      )}

      {['copilot', 'antigravity'].includes(selectedTool.id) && (
        <Text dimColor>
          {fit(
            selectedTool.id === 'antigravity' &&
              snapshot?.installations.find((i) => i.tool === 'antigravity')?.capabilities
                .configurationIsolation.supported
              ? 'ℹ n adds an experimental isolated login; a connects shared native login. One active agent per isolated profile.'
              : 'ℹ Choose accounts in the native tool; separate saved logins are not supported here.',
            width,
          )}
        </Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        {profileRows
          .slice(Math.max(0, listIndex - page + 1), Math.max(page, listIndex + 1))
          .map((item) => {
            const isSelected = item.id === selectedProfileRow?.id;
            const isActive = snapshot?.activeProfiles?.[item.tool] === item.id;
            const hc = item.nativeProfile?.handoffConstraints;
            const hcBadge =
              hc?.status === 'time-expired'
                ? ' · [TIME EXPIRED]'
                : hc?.status === 'quota-exhausted'
                  ? ' · [QUOTA EXHAUSTED]'
                  : hc
                    ? ' · [HANDOFF]'
                    : '';
            return (
              <Text key={item.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {fit(
                  `${isSelected ? '›' : ' '} ${item.label} · ${item.tool} · ${item.status}${isActive ? ' · [ACTIVE]' : ''}${hcBadge}`,
                  width,
                )}
              </Text>
            );
          })}
      </Box>

      {selectedProfileRow && (
        <Box marginTop={1}>
          <Text dimColor>
            {fit(
              profile
                ? profile.handoffConstraints
                  ? `Details: ${profile.reportedAccount ?? 'account'} · Constraints: ${profile.handoffConstraints.timeLimitHours ? `${profile.handoffConstraints.timeLimitHours}h time limit` : ''}${profile.handoffConstraints.quotaLimitPercent ? ` · ${profile.handoffConstraints.quotaLimitPercent}% quota limit` : ''} · ${profile.directory}`
                  : `Details: ${profile.reportedAccount ?? 'account not verified'} · ${profile.directory}`
                : selectedProfileRow.detail[0],
              width,
            )}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {profile
            ? `n add account · a existing login · S hot-swap active · l sign in${selectedTool.id === 'codex' ? ' · D device-code · I load native history' : selectedTool.id === 'antigravity' ? ' · I copy history (experimental)' : ''} · P current run · s launch · Enter more actions`
            : 'n add account · a existing login · Enter more actions'}
        </Text>
      </Box>
    </Box>
  );
}
