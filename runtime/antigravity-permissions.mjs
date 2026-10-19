export function deniedPermission(text) {
  return /(?:soft[- ]denied|permission (?:was )?denied|(?:requires?|needs?) (?:explicit )?(?:approval|permission)|(?:denied|blocked).*headless|headless.*(?:denied|blocked))/i.test(
    text,
  );
}
export function completedResult(code, result, stderr) {
  return (
    code === 0 &&
    result?.status === 'SUCCESS' &&
    !deniedPermission(stderr) &&
    !/print timeout.*(?:in progress|partial output)/i.test(stderr) &&
    !!(result.structured_output || result.response?.trim())
  );
}
export function workspacePermissions(permissions, writable) {
  const base = permissions ?? { allow: ['command(*)'], deny: ['mcp(*)', 'execute_url(*)'] };
  return {
    ...base,
    allow: [
      ...(base.allow ?? []),
      'read_file(/workspace)',
      ...(writable ? ['write_file(/workspace)'] : []),
    ],
  };
}
