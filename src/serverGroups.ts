export const GROUP_SEPARATOR = "/";

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
