/** Parse semver triplet [major, minor, patch] from version string. */
export function parseSemVer(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two semver versions.
 * Returns:
 *   1 if a > b
 *   0 if a === b
 *  -1 if a < b
 *  null if either cannot be parsed
 */
export function compareSemVer(a: string | null, b: string | null): number | null {
  const parsedA = parseSemVer(a);
  const parsedB = parseSemVer(b);
  if (!parsedA || !parsedB) return null;
  if (parsedA[0] !== parsedB[0]) return parsedA[0] > parsedB[0] ? 1 : -1;
  if (parsedA[1] !== parsedB[1]) return parsedA[1] > parsedB[1] ? 1 : -1;
  if (parsedA[2] !== parsedB[2]) return parsedA[2] > parsedB[2] ? 1 : -1;
  return 0;
}

/**
 * Determine if an installed version is forward-compatible with the baseline within the same major version family.
 * In SemVer:
 * - Major versions (e.g. 0.x, 1.x, 2.x) represent breaking API boundaries.
 * - For matching major versions, any minor or patch >= baseline is forward-compatible and auto-adapts dynamically.
 */
export function isCompatibleVersion(version: string | null, baseline: string): boolean {
  const parsedA = parseSemVer(version);
  const parsedB = parseSemVer(baseline);
  if (!parsedA || !parsedB) return false;
  if (parsedA[0] !== parsedB[0]) return false;
  if (parsedA[1] > parsedB[1]) return true;
  if (parsedA[1] === parsedB[1]) return parsedA[2] >= parsedB[2];
  return false;
}

/** Conservative stable patch families. This is eligibility, not proof of compatibility. */
export function compatiblePatch(version: string | null, baseline: string) {
  const parse = (value: string | null) =>
    value
      ?.match(/^(\d+)\.(\d+)\.(\d+)$/)
      ?.slice(1)
      .map(Number);
  const actual = parse(version),
    minimum = parse(baseline);
  return (
    !!actual &&
    !!minimum &&
    actual[0] === minimum[0] &&
    actual[1] === minimum[1] &&
    actual[2] >= minimum[2]
  );
}

