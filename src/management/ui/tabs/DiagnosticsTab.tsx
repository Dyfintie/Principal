import { Box, Text } from 'ink';
import type { DiagnosticsReport } from '../../diagnostics.js';
import { fit } from '../text.js';
export function DiagnosticsTab({
  report,
  width,
}: {
  report: DiagnosticsReport | null;
  width: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        TOOLS & CORE CAPABILITIES
      </Text>
      {!report && <Text dimColor>Checking supported native interfaces…</Text>}
      {report?.tools.map((i) => (
        <Text key={i.tool}>
          {fit(
            `${i.tool}: ${i.executable ? (i.version ?? 'version unknown') : 'not installed'} · native reads ${i.capabilities.resources.supported ? 'available' : 'unavailable'} · ${i.capabilities.resources.confidence}`,
            width,
          )}
        </Text>
      ))}
      {report && (
        <Box marginTop={1}>
          <Text dimColor>
            {fit(
              `Private isolation: ${Object.entries(report.isolation.dependencies)
                .map(([name, ok]) => name + (ok ? ' ✓' : ' missing'))
                .join(' · ')} · host keyring ${report.isolation.secretService}`,
              width,
            )}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold color="cyan">
          PROFILE HEALTH
        </Text>
      </Box>
      {report?.profiles.map((p) => (
        <Text key={p.id} color={p.status === 'Unauthorized' ? 'yellow' : undefined}>
          {fit(
            `${p.label} · ${p.tool} · ${p.status} · token expiry ${p.credential} · ${p.checkedAt ?? 'not verified'} · ${p.reason}`,
            width,
          )}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          Authentication checks do not run inference. /profiles → l sign in · Codex D device login.
        </Text>
      </Box>
    </Box>
  );
}
