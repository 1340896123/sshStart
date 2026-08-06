import type { ServerProfile } from "./types";

export const GROUP_SEPARATOR = "/";

export type ServerDropPosition = "before" | "after";

export interface GroupMoveTarget {
  parent: string;
  anchor?: string;
  position: "before" | "after" | "end";
}

export interface GroupMoveResult {
  groups: string[];
  servers: ServerProfile[];
  movedGroup: string;
}

export const normalizeGroupPath = (value: string) =>
  value
    .split(GROUP_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(GROUP_SEPARATOR);

export const groupLeaf = (path: string) => {
  const normalized = normalizeGroupPath(path);
  return normalized.slice(normalized.lastIndexOf(GROUP_SEPARATOR) + 1);
};

export const groupParent = (path: string) => {
  const normalized = normalizeGroupPath(path);
  const index = normalized.lastIndexOf(GROUP_SEPARATOR);
  return index < 0 ? "" : normalized.slice(0, index);
};

export const joinGroupPath = (parent: string, name: string) =>
  normalizeGroupPath([normalizeGroupPath(parent), name.trim()].filter(Boolean).join(GROUP_SEPARATOR));

export const groupAncestors = (path: string) => {
  const segments = normalizeGroupPath(path).split(GROUP_SEPARATOR).filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join(GROUP_SEPARATOR));
};

export const isGroupWithin = (path: string, group: string) => {
  const normalizedPath = normalizeGroupPath(path);
  const normalizedGroup = normalizeGroupPath(group);
  return normalizedPath === normalizedGroup || normalizedPath.startsWith(`${normalizedGroup}${GROUP_SEPARATOR}`);
};

export const replaceGroupPrefix = (path: string, currentGroup: string, nextGroup: string) => {
  const normalizedPath = normalizeGroupPath(path);
  const current = normalizeGroupPath(currentGroup);
  const next = normalizeGroupPath(nextGroup);
  if (normalizedPath === current) return next;
  if (!normalizedPath.startsWith(`${current}${GROUP_SEPARATOR}`)) return normalizedPath;
  return `${next}${normalizedPath.slice(current.length)}`;
};

export const removeGroupLevel = (path: string, group: string) => {
  const normalizedPath = normalizeGroupPath(path);
  const current = normalizeGroupPath(group);
  if (!isGroupWithin(normalizedPath, current)) return normalizedPath;

  const parent = groupParent(current);
  const remainder = normalizedPath.slice(current.length).replace(/^\//, "");
  return joinGroupPath(parent, remainder);
};

export const groupBreadcrumb = (path: string) =>
  normalizeGroupPath(path).split(GROUP_SEPARATOR).filter(Boolean).join(" / ");

export const collectOrderedGroupPaths = (savedGroups: string[], servers: ServerProfile[]) => {
  const orderedPaths: string[] = [];
  const addPath = (path: string) => {
    groupAncestors(path).forEach((ancestor) => {
      if (!orderedPaths.includes(ancestor)) orderedPaths.push(ancestor);
    });
  };

  savedGroups.forEach(addPath);
  servers.forEach((server) => addPath(server.group));
  return orderedPaths;
};

export const moveServerToPosition = (
  servers: ServerProfile[],
  serverId: string,
  targetGroup: string,
  targetServerId?: string,
  position: ServerDropPosition = "after",
) => {
  if (serverId === targetServerId) return servers;
  const movingServer = servers.find((server) => server.id === serverId);
  if (!movingServer) return servers;

  const normalizedGroup = normalizeGroupPath(targetGroup);
  const remaining = servers.filter((server) => server.id !== serverId);
  const nextServer = { ...movingServer, group: normalizedGroup };

  if (targetServerId) {
    const targetIndex = remaining.findIndex((server) => server.id === targetServerId);
    if (targetIndex >= 0) {
      const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      return [...remaining.slice(0, insertIndex), nextServer, ...remaining.slice(insertIndex)];
    }
  }

  let lastGroupIndex = -1;
  remaining.forEach((server, index) => {
    if (normalizeGroupPath(server.group) === normalizedGroup) lastGroupIndex = index;
  });
  const insertIndex = lastGroupIndex >= 0 ? lastGroupIndex + 1 : remaining.length;
  return [...remaining.slice(0, insertIndex), nextServer, ...remaining.slice(insertIndex)];
};

export const resolveMovedGroupPath = (sourceGroup: string, target: GroupMoveTarget) =>
  joinGroupPath(target.parent, groupLeaf(sourceGroup));

export const canMoveGroup = (
  groupPaths: string[],
  sourceGroup: string,
  target: GroupMoveTarget,
) => {
  const source = normalizeGroupPath(sourceGroup);
  const parent = normalizeGroupPath(target.parent);
  const anchor = normalizeGroupPath(target.anchor ?? "");
  if (!source || parent === source || (parent && isGroupWithin(parent, source))) return false;
  if (anchor && groupParent(anchor) !== parent) return false;
  if (anchor === source) return false;

  const movedGroup = resolveMovedGroupPath(source, { ...target, parent });
  return movedGroup === source || !groupPaths.includes(movedGroup);
};

export const moveGroupToPosition = (
  savedGroups: string[],
  servers: ServerProfile[],
  sourceGroup: string,
  target: GroupMoveTarget,
): GroupMoveResult | null => {
  const orderedPaths = collectOrderedGroupPaths(savedGroups, servers);
  const source = normalizeGroupPath(sourceGroup);
  const normalizedTarget: GroupMoveTarget = {
    ...target,
    parent: normalizeGroupPath(target.parent),
    anchor: target.anchor ? normalizeGroupPath(target.anchor) : undefined,
  };
  if (!orderedPaths.includes(source) || !canMoveGroup(orderedPaths, source, normalizedTarget)) return null;

  interface GroupOrderNode {
    path: string;
    children: GroupOrderNode[];
  }

  const nodes = new Map(orderedPaths.map((path) => [path, { path, children: [] } as GroupOrderNode]));
  const roots: GroupOrderNode[] = [];
  orderedPaths.forEach((path) => {
    const node = nodes.get(path);
    if (!node) return;
    const parent = groupParent(path);
    if (parent) nodes.get(parent)?.children.push(node);
    else roots.push(node);
  });

  const sourceNode = nodes.get(source);
  const destinationParent = normalizedTarget.parent ? nodes.get(normalizedTarget.parent) : undefined;
  if (!sourceNode || (normalizedTarget.parent && !destinationParent)) return null;

  const sourceSiblings = groupParent(source) ? nodes.get(groupParent(source))?.children : roots;
  const sourceIndex = sourceSiblings?.findIndex((node) => node.path === source) ?? -1;
  if (!sourceSiblings || sourceIndex < 0) return null;
  sourceSiblings.splice(sourceIndex, 1);

  const destinationSiblings = destinationParent?.children ?? roots;
  let insertIndex = destinationSiblings.length;
  if (normalizedTarget.anchor) {
    const anchorIndex = destinationSiblings.findIndex((node) => node.path === normalizedTarget.anchor);
    if (anchorIndex >= 0) insertIndex = normalizedTarget.position === "before" ? anchorIndex : anchorIndex + 1;
  }
  destinationSiblings.splice(insertIndex, 0, sourceNode);

  const movedGroup = resolveMovedGroupPath(source, normalizedTarget);
  const groups: string[] = [];
  const visit = (node: GroupOrderNode) => {
    groups.push(replaceGroupPrefix(node.path, source, movedGroup));
    node.children.forEach(visit);
  };
  roots.forEach(visit);

  return {
    groups,
    servers: servers.map((server) => ({
      ...server,
      group: replaceGroupPrefix(server.group, source, movedGroup),
    })),
    movedGroup,
  };
};
