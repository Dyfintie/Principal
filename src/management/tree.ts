import type { Folder, Invocation, SessionEntry, Snapshot } from './model.js';

export interface TreeRow {
  id: string;
  kind: 'folder' | 'project' | 'entry';
  label: string;
  depth: number;
  parent: string | null;
  folderId: string;
  projectId?: string;
  entryId?: string;
  count: number;
  expanded: boolean;
  activity?: string;
  summary?: string;
}
export function invocationLabel(invocation?: Invocation) {
  if (!invocation) return 'History';
  if (invocation.lifecycle === 'exited') return 'Exited';
  if (invocation.lifecycle !== 'running')
    return invocation.lifecycle === 'starting' ? 'Starting' : 'Unknown';
  const terminal = invocation.hasControllingTerminal === false ? ' · no controlling terminal' : '';
  if (invocation.connection !== 'connected') return 'Running' + terminal + ' · state stale';
  const label = {
    working: 'Working',
    'awaiting-user': 'Awaiting input',
    idle: 'Idle',
    unknown: 'Running · activity unknown',
  }[invocation.activity];
  return (
    label + terminal + (invocation.activitySource?.startsWith('Claude ') ? ' · hook signal' : '')
  );
}
export function flattenTree(
  snapshot: Snapshot,
  expanded: Set<string>,
  search = '',
  showArchived = false,
): TreeRow[] {
  const query = search.toLocaleLowerCase().trim();
  const invocationsByEntry = new Map<string, Invocation>();
  for (const inv of snapshot.invocations) {
    const existing = invocationsByEntry.get(inv.entryId);
    if (!existing || inv.startedAt.localeCompare(existing.startedAt) > 0) {
      invocationsByEntry.set(inv.entryId, inv);
    }
  }
  const projectsById = new Map(snapshot.projects.map((p) => [p.id, p]));
  const profilesById = new Map(snapshot.profiles.map((p) => [p.id, p]));

  const matches = (entry: SessionEntry) => {
    if (!!entry.archivedAt !== showArchived) return false;
    const invocation = invocationsByEntry.get(entry.id);
    // Generic process sightings are not saved conversations. Keep live sightings
    // useful without accumulating every ended helper/process in the main tree.
    if (
      !showArchived &&
      !entry.conversationId &&
      entry.title === `${entry.tool} · external process` &&
      invocation &&
      !invocation.owned &&
      invocation.lifecycle === 'exited'
    )
      return false;

    const project = projectsById.get(entry.projectId);
    const profile = entry.profileId ? profilesById.get(entry.profileId) : undefined;
    return (
      !query ||
      [entry.title, entry.tool, project?.name, project?.directory, profile?.label]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    );
  };
  const entries = snapshot.entries.filter(matches);
  const folders = [...snapshot.folders].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const rows: TreeRow[] = [];
  const summary = (items: SessionEntry[]) => {
    let working = 0,
      waiting = 0;
    for (const e of items) {
      const invocation = invocationsByEntry.get(e.id);
      if (invocation?.lifecycle !== 'running' || invocation.connection !== 'connected') continue;
      if (invocation.activity === 'working') working++;
      if (invocation.activity === 'awaiting-user') waiting++;
    }
    return [working ? `${working} working` : '', waiting ? `${waiting} awaiting input` : '']
      .filter(Boolean)
      .join(' · ');
  };
  const visited = new Set<string>();
  const descendants = (folder: Folder): Set<string> => {
    const ids = new Set([folder.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const f of folders)
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          changed = true;
        }
    }
    return ids;
  };
  const visit = (folder: Folder, depth: number, parent: string | null) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    const children = entries.filter((e) => descendants(folder).has(e.folderId));
    if (query && !children.length) return;
    const id = `f:${folder.id}`;
    const open = !!query || expanded.has(id);
    rows.push({
      id,
      kind: 'folder',
      label: folder.name,
      depth,
      parent,
      folderId: folder.id,
      count: children.length,
      expanded: open,
      summary: summary(children),
    });
    if (!open) return;
    for (const child of folders.filter((f) => f.parentId === folder.id))
      visit(child, depth + 1, id);
    const direct = entries.filter((e) => e.folderId === folder.id);
    const projects = snapshot.projects
      .filter((p) => direct.some((e) => e.projectId === p.id))
      .sort((a, b) => a.name.localeCompare(b.name) || a.directory.localeCompare(b.directory));
    for (const project of projects) {
      const projectId = `p:${folder.id}:${project.id}`;
      const sessions = direct.filter((e) => e.projectId === project.id);
      const openProject = !!query || expanded.has(projectId);
      rows.push({
        id: projectId,
        kind: 'project',
        label: project.name,
        depth: depth + 1,
        parent: id,
        folderId: folder.id,
        projectId: project.id,
        count: sessions.length,
        expanded: openProject,
        summary: summary(sessions),
      });
      if (openProject)
        for (const entry of sessions) {
          const profile = entry.profileId ? profilesById.get(entry.profileId) : undefined;
          const invocation = invocationsByEntry.get(entry.id);
          rows.push({
            id: `e:${entry.id}`,
            kind: 'entry',
            label: `${entry.title} · ${entry.tool} · ${profile?.label ?? 'profile unknown'}`,
            depth: depth + 2,
            parent: projectId,
            folderId: folder.id,
            projectId: project.id,
            entryId: entry.id,
            count: 0,
            expanded: false,
            activity: invocationLabel(invocation),
          });
        }
    }
  };
  for (const root of folders.filter((f) => !f.parentId)) visit(root, 0, null);
  return rows;
}
export function folderPath(id: string, folders: Folder[]): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let current: string | null = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parentId;
  }
  return names.join('/');
}
