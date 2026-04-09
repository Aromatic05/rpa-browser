<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type {
  CaptureEnvelope,
  CaptureItemApiResponse,
  CaptureListApiResponse,
  CaptureListItem,
  Content,
  DataPack,
  EntityIndexLike,
  EntityRecordLike,
  GroupEntityLike,
  LocatorLike,
  NodeEntityRefLike,
  RawDomNodeLike,
  RegionEntityLike,
  SnapshotApiResponse,
  SnapshotGraphLike,
  TreeNodeLike,
} from './types';

const error = ref('');
const loading = ref(false);
const targetUrl = ref('https://example.com');
const resolvedUrl = ref('');
const selectedNode = ref<TreeNodeLike | null>(null);
const copyMessage = ref('');

const captures = ref<CaptureListItem[]>([]);
const captureStoreDir = ref('');
const captureLoading = ref(false);
const selectedCaptureId = ref('');
let capturePollTimer: number | null = null;

const selectedEntityId = ref('');
const focusEntityTree = ref(true);
const centerMode = ref<'entities' | 'tree'>('entities');

const contextMenu = ref<{
  visible: boolean;
  x: number;
  y: number;
  node: TreeNodeLike | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  node: null,
});

const dataPack = ref<DataPack>({
  snapshot: null,
});

type GroupAssessment = {
  id: string;
  kind: string;
  containerId: string;
  keySlot: number;
  itemCount: number;
  coverage: number;
  uniqueness: number;
  score: number;
  sampleKeys: string[];
};

type EntityTableRow = {
  id: string;
  type: 'region' | 'group';
  kind: string;
  label: string;
  anchorId: string;
  itemCount: number;
  keySlot?: number;
  score?: number;
  size: number;
};

type GroupPreviewRow = {
  itemId: string;
  slots: Record<number, string>;
  summary: string;
};

type GroupPreview = {
  group: GroupEntityLike;
  slots: number[];
  rows: GroupPreviewRow[];
};

type FormPreviewRow = {
  nodeId: string;
  field: string;
  value: string;
};

type PreviewControl = {
  kind: 'input' | 'select' | 'textarea' | 'switch' | 'checkbox' | 'radio' | 'button' | 'text';
  text?: string;
  primary?: boolean;
};

type GroupFormRow = {
  id: string;
  label: string;
  controls: PreviewControl[];
};

type RawDomIndex = {
  byBackendId: Record<string, RawDomNodeLike>;
  parentByBackendId: Record<string, string>;
  stylesheetHrefs: string[];
};

type EntityDomPreview = {
  rootDomId: string;
  mappedDomCount: number;
  srcdoc: string;
};

const normalizeContent = (
  maybe: Record<string, unknown>,
  id: string,
  legacyContent: Record<string, string>,
): Content | undefined => {
  if (typeof maybe.content === 'string') {
    const inlineContent = maybe.content.trim();
    return inlineContent ? inlineContent : undefined;
  }

  if (maybe.content && typeof maybe.content === 'object') {
    const ref = (maybe.content as Record<string, unknown>).ref;
    if (typeof ref === 'string' && ref.trim()) {
      return { ref: ref.trim() };
    }
  }

  if (typeof maybe.contentRef === 'string' && maybe.contentRef.trim()) {
    return { ref: maybe.contentRef.trim() };
  }

  const legacy = typeof maybe.text === 'string' ? maybe.text.trim() : '';
  if (legacy) {
    const contentRef = `legacy_content_${id}`;
    legacyContent[contentRef] = legacy;
    return { ref: contentRef };
  }

  return undefined;
};

const normalizeNode = (value: unknown, fallbackId = 'n0', legacyContent: Record<string, string>): TreeNodeLike | null => {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as Record<string, unknown>;
  const id = typeof maybe.id === 'string' ? maybe.id : fallbackId;
  const content = normalizeContent(maybe, id, legacyContent);

  const rawChildren = Array.isArray(maybe.children) ? maybe.children : [];
  const children = rawChildren
    .map((child, index) => normalizeNode(child, `${id}.${index}`, legacyContent))
    .filter((node): node is TreeNodeLike => Boolean(node));

  return {
    id,
    role: typeof maybe.role === 'string' ? maybe.role : undefined,
    name: typeof maybe.name === 'string' ? maybe.name : undefined,
    content,
    target:
      maybe.target && typeof maybe.target === 'object'
        ? (maybe.target as { ref?: string; kind?: string })
        : undefined,
    children,
  };
};

const walk = (node: TreeNodeLike, visitor: (node: TreeNodeLike) => void) => {
  visitor(node);
  for (const child of node.children) {
    walk(child, visitor);
  }
};

const buildNodeIndexFromTree = (root: TreeNodeLike): Record<string, TreeNodeLike> => {
  const out: Record<string, TreeNodeLike> = {};
  walk(root, (node) => {
    out[node.id] = node;
  });
  return out;
};

const createEmptyEntityIndex = (): EntityIndexLike => ({
  entities: {},
  byNodeId: {},
});

const asRegionEntity = (value: Record<string, unknown>, fallbackId: string): RegionEntityLike | null => {
  const nodeId = typeof value.nodeId === 'string' ? value.nodeId : '';
  if (!nodeId) return null;
  const id = typeof value.id === 'string' ? value.id : fallbackId;
  const kind = typeof value.kind === 'string' ? value.kind : 'panel';
  return {
    id,
    type: 'region',
    kind,
    nodeId,
    name: typeof value.name === 'string' ? value.name : undefined,
    bbox:
      value.bbox && typeof value.bbox === 'object'
        ? (value.bbox as { x: number; y: number; width: number; height: number })
        : undefined,
  };
};

const asGroupEntity = (value: Record<string, unknown>, fallbackId: string): GroupEntityLike | null => {
  const containerId = typeof value.containerId === 'string' ? value.containerId : '';
  if (!containerId) return null;
  const id = typeof value.id === 'string' ? value.id : fallbackId;
  const kind = typeof value.kind === 'string' ? value.kind : 'list';
  const itemIds = Array.isArray(value.itemIds)
    ? value.itemIds.filter((item): item is string => typeof item === 'string')
    : [];
  const keySlot = typeof value.keySlot === 'number' ? value.keySlot : 0;
  return {
    id,
    type: 'group',
    kind,
    containerId,
    itemIds,
    keySlot,
  };
};

const asNodeEntityRef = (value: unknown): NodeEntityRefLike | null => {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as Record<string, unknown>;
  const type = maybe.type === 'region' || maybe.type === 'group' ? maybe.type : null;
  const entityId = typeof maybe.entityId === 'string' ? maybe.entityId : '';
  const role =
    maybe.role === 'container' || maybe.role === 'item' || maybe.role === 'descendant'
      ? maybe.role
      : null;
  if (!type || !entityId || !role) return null;
  return {
    type,
    entityId,
    role,
    itemId: typeof maybe.itemId === 'string' ? maybe.itemId : undefined,
    slotIndex: typeof maybe.slotIndex === 'number' ? maybe.slotIndex : undefined,
  };
};

const normalizeEntityIndex = (value: unknown): EntityIndexLike => {
  const normalized = createEmptyEntityIndex();
  if (!value || typeof value !== 'object') return normalized;
  const maybe = value as Record<string, unknown>;

  if (maybe.entities && typeof maybe.entities === 'object') {
    for (const [entityId, rawEntity] of Object.entries(maybe.entities as Record<string, unknown>)) {
      if (!rawEntity || typeof rawEntity !== 'object') continue;
      const entityObject = rawEntity as Record<string, unknown>;
      const type = entityObject.type;
      if (type === 'group') {
        const group = asGroupEntity(entityObject, entityId);
        if (group) normalized.entities[group.id] = group;
        continue;
      }
      const region = asRegionEntity(entityObject, entityId);
      if (region) normalized.entities[region.id] = region;
    }
  } else {
    for (const [entityId, rawEntity] of Object.entries(maybe)) {
      if (!rawEntity || typeof rawEntity !== 'object') continue;
      const region = asRegionEntity(rawEntity as Record<string, unknown>, entityId);
      if (region) normalized.entities[region.id] = region;
    }
  }

  if (maybe.byNodeId && typeof maybe.byNodeId === 'object') {
    for (const [nodeId, refs] of Object.entries(maybe.byNodeId as Record<string, unknown>)) {
      if (!Array.isArray(refs)) continue;
      const normalizedRefs = refs
        .map((item) => asNodeEntityRef(item))
        .filter((item): item is NodeEntityRefLike => Boolean(item));
      if (normalizedRefs.length > 0) {
        normalized.byNodeId[nodeId] = normalizedRefs;
      }
    }
  }

  for (const entity of Object.values(normalized.entities)) {
    if (entity.type !== 'region') continue;
    const refs = normalized.byNodeId[entity.nodeId] || [];
    const hasContainerRef = refs.some((ref) => ref.type === 'region' && ref.entityId === entity.id && ref.role === 'container');
    if (!hasContainerRef) {
      refs.push({
        type: 'region',
        entityId: entity.id,
        role: 'container',
      });
      normalized.byNodeId[entity.nodeId] = refs;
    }
  }

  return normalized;
};

const normalizeRawDomTree = (value: unknown): RawDomNodeLike | null => {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as Record<string, unknown>;
  if (typeof maybe.tag !== 'string') return null;
  if (!Array.isArray(maybe.children)) return null;
  return value as RawDomNodeLike;
};

const normalizeSnapshot = (value: unknown): SnapshotGraphLike | null => {
  if (!value || typeof value !== 'object') return null;

  const maybe = value as Record<string, unknown>;
  const rawRoot = 'root' in maybe ? maybe.root : value;
  const legacyContent: Record<string, string> = {};
  const root = normalizeNode(rawRoot, 'n0', legacyContent);
  if (!root) return null;

  const nodeIndex =
    maybe.nodeIndex && typeof maybe.nodeIndex === 'object'
      ? (maybe.nodeIndex as Record<string, TreeNodeLike>)
      : buildNodeIndexFromTree(root);

  const contentStore = {
    ...(maybe.contentStore && typeof maybe.contentStore === 'object'
      ? (maybe.contentStore as Record<string, string>)
      : {}),
    ...legacyContent,
  };

  return {
    root,
    nodeIndex,
    entityIndex: normalizeEntityIndex(maybe.entityIndex),
    locatorIndex:
      maybe.locatorIndex && typeof maybe.locatorIndex === 'object'
        ? (maybe.locatorIndex as Record<string, LocatorLike>)
        : {},
    bboxIndex:
      maybe.bboxIndex && typeof maybe.bboxIndex === 'object'
        ? (maybe.bboxIndex as Record<string, { x: number; y: number; width: number; height: number }>)
        : {},
    attrIndex:
      maybe.attrIndex && typeof maybe.attrIndex === 'object'
        ? (maybe.attrIndex as Record<string, Record<string, unknown>>)
        : {},
    contentStore,
    cacheStats:
      maybe.cacheStats && typeof maybe.cacheStats === 'object'
        ? (maybe.cacheStats as { bucketTotal: number; bucketHit: number; bucketMiss: number })
        : undefined,
  };
};

const isRegionEntity = (entity: EntityRecordLike): entity is RegionEntityLike => entity.type === 'region';
const isGroupEntity = (entity: EntityRecordLike): entity is GroupEntityLike => entity.type === 'group';

const activeSnapshot = computed(() => dataPack.value.snapshot);
const activeRoot = computed(() => activeSnapshot.value?.root || null);
const activeEntityIndex = computed(() => activeSnapshot.value?.entityIndex || createEmptyEntityIndex());

const regionItems = computed(() =>
  Object.values(activeEntityIndex.value.entities)
    .filter((entity): entity is RegionEntityLike => isRegionEntity(entity))
    .sort((a, b) => `${a.kind}|${a.name || ''}|${a.id}`.localeCompare(`${b.kind}|${b.name || ''}|${b.id}`)),
);

const groupItems = computed(() =>
  Object.values(activeEntityIndex.value.entities)
    .filter((entity): entity is GroupEntityLike => isGroupEntity(entity))
    .sort((a, b) => (b.itemIds.length - a.itemIds.length) || `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`)),
);

const resolveNodeContent = (node: TreeNodeLike, snapshot: SnapshotGraphLike): string => {
  if (typeof node.content === 'string') return node.content;
  if (node.content?.ref) return snapshot.contentStore?.[node.content.ref] || '';
  return '';
};

const normalizeText = (value: string | undefined): string => (value || '').replace(/\s+/g, ' ').trim();

const resolveNodeText = (nodeId: string, snapshot: SnapshotGraphLike): string => {
  const node = snapshot.nodeIndex?.[nodeId];
  if (!node) return '';
  const attrs = snapshot.attrIndex?.[nodeId] || {};
  const content = resolveNodeContent(node, snapshot);
  const candidates = [
    node.name,
    content,
    typeof attrs['aria-label'] === 'string' ? attrs['aria-label'] : undefined,
    typeof attrs.title === 'string' ? attrs.title : undefined,
    typeof attrs.placeholder === 'string' ? attrs.placeholder : undefined,
    typeof attrs.value === 'string' ? attrs.value : undefined,
  ];
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!text || text.length > 120) continue;
    return text;
  }
  return '';
};

const firstReadableDescendantText = (nodeId: string, snapshot: SnapshotGraphLike, depthLimit: number): string => {
  const root = snapshot.nodeIndex?.[nodeId];
  if (!root) return '';
  const queue: Array<{ node: TreeNodeLike; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const own = resolveNodeText(current.node.id, snapshot);
    if (own) return own;
    if (current.depth >= depthLimit) continue;
    for (const child of current.node.children) {
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return '';
};

const collectReadableTexts = (
  nodeId: string,
  snapshot: SnapshotGraphLike,
  limit: number,
  depthLimit: number,
): string[] => {
  const root = snapshot.nodeIndex?.[nodeId];
  if (!root) return [];
  const out: string[] = [];
  const dedupe = new Set<string>();
  const queue: Array<{ node: TreeNodeLike; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    if (!current) break;
    const text = resolveNodeText(current.node.id, snapshot);
    if (text) {
      const key = text.toLowerCase();
      if (!dedupe.has(key)) {
        dedupe.add(key);
        out.push(text);
        if (out.length >= limit) break;
      }
    }
    if (current.depth >= depthLimit) continue;
    for (const child of current.node.children) {
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return out;
};

const collectSubtreeIds = (snapshot: SnapshotGraphLike, nodeId: string, out: Set<string>) => {
  const root = snapshot.nodeIndex?.[nodeId];
  if (!root) return;
  walk(root, (node) => {
    out.add(node.id);
  });
};

const buildGroupSlotMap = (entityIndex: EntityIndexLike): Map<string, Map<string, Map<number, string[]>>> => {
  const map = new Map<string, Map<string, Map<number, string[]>>>();
  for (const [nodeId, refs] of Object.entries(entityIndex.byNodeId || {})) {
    if (!refs || refs.length === 0) continue;
    for (const ref of refs) {
      if (ref.type !== 'group') continue;
      if (ref.slotIndex === undefined || !ref.itemId) continue;

      const byItem = map.get(ref.entityId) || new Map<string, Map<number, string[]>>();
      const bySlot = byItem.get(ref.itemId) || new Map<number, string[]>();
      const nodeIds = bySlot.get(ref.slotIndex) || [];
      nodeIds.push(nodeId);
      bySlot.set(ref.slotIndex, nodeIds);
      byItem.set(ref.itemId, bySlot);
      map.set(ref.entityId, byItem);
    }
  }
  return map;
};

const resolveGroupKeyText = (
  snapshot: SnapshotGraphLike,
  slotMap: Map<string, Map<string, Map<number, string[]>>>,
  group: GroupEntityLike,
  itemId: string,
): string => {
  const candidateNodeIds = slotMap.get(group.id)?.get(itemId)?.get(group.keySlot) || [];
  for (const nodeId of candidateNodeIds) {
    const text = resolveNodeText(nodeId, snapshot);
    if (text) return text;
  }
  return firstReadableDescendantText(itemId, snapshot, 2);
};

const groupAssessments = computed<GroupAssessment[]>(() => {
  const snapshot = activeSnapshot.value;
  if (!snapshot) return [];
  const slotMap = buildGroupSlotMap(activeEntityIndex.value);

  return groupItems.value.map((group) => {
    const keys = group.itemIds.map((itemId) => resolveGroupKeyText(snapshot, slotMap, group, itemId));
    const nonEmpty = keys.filter((text) => text.length > 0);
    const coverage = group.itemIds.length > 0 ? nonEmpty.length / group.itemIds.length : 0;
    const unique = new Set(nonEmpty.map((text) => text.toLowerCase()));
    const uniqueness = nonEmpty.length > 0 ? unique.size / nonEmpty.length : 0;
    const score = 0.6 * uniqueness + 0.4 * coverage;

    return {
      id: group.id,
      kind: group.kind,
      containerId: group.containerId,
      keySlot: group.keySlot,
      itemCount: group.itemIds.length,
      coverage,
      uniqueness,
      score,
      sampleKeys: nonEmpty.slice(0, 6),
    };
  });
});

const groupAssessmentMap = computed(() => {
  const map = new Map<string, GroupAssessment>();
  for (const item of groupAssessments.value) {
    map.set(item.id, item);
  }
  return map;
});

const regionNodeSizeMap = computed(() => {
  const root = activeRoot.value;
  const out: Record<string, number> = {};
  if (!root) return out;

  const count = (node: TreeNodeLike): number => {
    let size = 1;
    for (const child of node.children) {
      size += count(child);
    }
    out[node.id] = size;
    return size;
  };

  count(root);
  return out;
});

const entityRows = computed<EntityTableRow[]>(() => {
  const snapshot = activeSnapshot.value;
  if (!snapshot) return [];

  const rows: EntityTableRow[] = [];

  for (const region of regionItems.value) {
    rows.push({
      id: region.id,
      type: 'region',
      kind: region.kind,
      label: region.name || resolveNodeText(region.nodeId, snapshot) || '-',
      anchorId: region.nodeId,
      itemCount: 0,
      size: regionNodeSizeMap.value[region.nodeId] || 1,
    });
  }

  for (const group of groupItems.value) {
    const assessment = groupAssessmentMap.value.get(group.id);
    rows.push({
      id: group.id,
      type: 'group',
      kind: group.kind,
      label: assessment?.sampleKeys[0] || resolveNodeText(group.containerId, snapshot) || '-',
      anchorId: group.containerId,
      itemCount: group.itemIds.length,
      keySlot: group.keySlot,
      score: assessment?.score || 0,
      size: group.itemIds.length,
    });
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
    if (a.type === 'group' && b.type === 'group') {
      return (b.itemCount - a.itemCount) || `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`);
    }
    return (b.size - a.size) || `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`);
  });

  return rows;
});

const majorEntityRows = computed<EntityTableRow[]>(() => {
  const rows = entityRows.value.filter((row) => {
    if (row.type === 'group') return row.itemCount >= 2;
    if (row.size >= 10) return true;
    return ['form', 'table', 'dialog', 'list', 'toolbar', 'panel'].includes(row.kind);
  });
  return rows.length > 0 ? rows : entityRows.value;
});

watch(majorEntityRows, (rows) => {
  if (rows.length === 0) {
    selectedEntityId.value = '';
    return;
  }
  if (!rows.some((row) => row.id === selectedEntityId.value)) {
    selectedEntityId.value = rows[0].id;
  }
}, { immediate: true });

const selectedEntity = computed<EntityRecordLike | null>(() => {
  const id = selectedEntityId.value;
  if (!id) return null;
  return activeEntityIndex.value.entities[id] || null;
});

const selectedEntityRow = computed<EntityTableRow | null>(() => {
  const id = selectedEntityId.value;
  if (!id) return null;
  return majorEntityRows.value.find((row) => row.id === id) || null;
});

const highlightIdMap = computed<Record<string, boolean>>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  if (!snapshot || !entity) return {};

  const ids = new Set<string>();

  for (const [nodeId, refs] of Object.entries(activeEntityIndex.value.byNodeId || {})) {
    if (!refs || refs.length === 0) continue;
    if (refs.some((ref) => ref.entityId === entity.id && ref.type === entity.type)) {
      ids.add(nodeId);
    }
  }

  if (entity.type === 'region') {
    collectSubtreeIds(snapshot, entity.nodeId, ids);
  } else {
    collectSubtreeIds(snapshot, entity.containerId, ids);
    for (const itemId of entity.itemIds) {
      collectSubtreeIds(snapshot, itemId, ids);
    }
  }

  const map: Record<string, boolean> = {};
  for (const id of ids) {
    map[id] = true;
  }
  return map;
});

const activeTreeRoot = computed<TreeNodeLike | null>(() => {
  const root = activeRoot.value;
  if (!root) return null;
  if (!focusEntityTree.value) return root;
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  if (!snapshot || !entity) return root;
  const anchorId = entity.type === 'group' ? entity.containerId : entity.nodeId;
  return snapshot.nodeIndex?.[anchorId] || root;
});

const groupSlotMap = computed(() => buildGroupSlotMap(activeEntityIndex.value));

const parentNodeIdMap = computed<Record<string, string>>(() => {
  const root = activeRoot.value;
  const map: Record<string, string> = {};
  if (!root) return map;

  const stack: Array<{ node: TreeNodeLike; parentId: string }> = [{ node: root, parentId: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    map[current.node.id] = current.parentId;
    for (let i = current.node.children.length - 1; i >= 0; i -= 1) {
      const child = current.node.children[i];
      if (!child) continue;
      stack.push({ node: child, parentId: current.node.id });
    }
  }
  return map;
});

const selectedGroupPreview = computed<GroupPreview | null>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  if (!snapshot || !entity || entity.type !== 'group') return null;

  const byItem = groupSlotMap.value.get(entity.id) || new Map<string, Map<number, string[]>>();
  const slotSet = new Set<number>();
  const rows: GroupPreviewRow[] = [];

  for (const itemId of entity.itemIds.slice(0, 50)) {
    const bySlot = byItem.get(itemId) || new Map<number, string[]>();
    const slots: Record<number, string> = {};

    for (const [slotIndex, nodeIds] of bySlot.entries()) {
      slotSet.add(slotIndex);
      let text = '';
      for (const nodeId of nodeIds) {
        text = resolveNodeText(nodeId, snapshot);
        if (text) break;
      }
      slots[slotIndex] = text;
    }

    if (Object.keys(slots).length === 0) {
      slotSet.add(entity.keySlot);
      slots[entity.keySlot] = '';
    }

    rows.push({
      itemId,
      slots,
      summary: firstReadableDescendantText(itemId, snapshot, 2),
    });
  }

  const slots = Array.from(slotSet).sort((a, b) => a - b);
  for (const row of rows) {
    for (const slot of slots) {
      const existing = row.slots[slot];
      if (existing && existing.trim()) continue;
      if (slot === entity.keySlot) {
        row.slots[slot] = row.summary;
      } else {
        row.slots[slot] = row.slots[slot] || '';
      }
    }
  }

  return {
    group: entity,
    slots,
    rows,
  };
});

const nodeTag = (snapshot: SnapshotGraphLike, nodeId: string): string => {
  const attrs = snapshot.attrIndex?.[nodeId] || {};
  const value = typeof attrs.tag === 'string'
    ? attrs.tag
    : typeof attrs.tagName === 'string'
      ? attrs.tagName
      : '';
  return normalizeText(value)?.toLowerCase() || '';
};

const isHeaderLikeNode = (snapshot: SnapshotGraphLike, nodeId: string): boolean => {
  const node = snapshot.nodeIndex?.[nodeId];
  if (!node) return false;
  const role = normalizeText(node.role)?.toLowerCase() || '';
  const tag = nodeTag(snapshot, nodeId);
  return role === 'columnheader' || role === 'rowheader' || role === 'heading' || tag === 'th';
};

const pickMostFrequentText = (texts: string[]): string => {
  const scoreByText = new Map<string, number>();
  const rawByLower = new Map<string, string>();
  for (const text of texts) {
    const normalized = normalizeText(text);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    rawByLower.set(lower, normalized);
    scoreByText.set(lower, (scoreByText.get(lower) || 0) + 1);
  }
  let best = '';
  let bestScore = 0;
  for (const [lower, score] of scoreByText.entries()) {
    if (score > bestScore) {
      best = rawByLower.get(lower) || '';
      bestScore = score;
    }
  }
  return best;
};

const extractTheadHeaders = (snapshot: SnapshotGraphLike, tableNode: TreeNodeLike, slotCount: number): string[] => {
  const thead = tableNode.children.find((child) => {
    const role = normalizeText(child.role)?.toLowerCase() || '';
    const tag = nodeTag(snapshot, child.id);
    return role === 'thead' || tag === 'thead';
  });
  if (!thead) return [];

  const row = thead.children.find((child) => {
    const role = normalizeText(child.role)?.toLowerCase() || '';
    const tag = nodeTag(snapshot, child.id);
    return role === 'row' || tag === 'tr';
  });
  if (!row) return [];

  const cells = row.children.filter((child) => {
    const role = normalizeText(child.role)?.toLowerCase() || '';
    const tag = nodeTag(snapshot, child.id);
    return role === 'columnheader' || role === 'cell' || tag === 'th' || tag === 'td';
  });

  if (cells.length === 0) return [];
  const out: string[] = [];
  const max = Math.min(slotCount, cells.length);
  for (let i = 0; i < max; i += 1) {
    const cell = cells[i];
    if (!cell) {
      out.push('');
      continue;
    }
    out.push(resolveNodeText(cell.id, snapshot));
  }
  return out;
};

const selectedGroupColumnHeaders = computed<Record<number, string>>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  const preview = selectedGroupPreview.value;
  if (!snapshot || !entity || entity.type !== 'group' || entity.kind !== 'table' || !preview) return {};

  const headers: Record<number, string> = {};
  const byItem = groupSlotMap.value.get(entity.id) || new Map<string, Map<number, string[]>>();

  for (const slot of preview.slots) {
    const texts: string[] = [];
    for (const itemId of entity.itemIds.slice(0, 8)) {
      const bySlot = byItem.get(itemId);
      if (!bySlot) continue;
      const nodeIds = bySlot.get(slot) || [];
      for (const nodeId of nodeIds) {
        if (!isHeaderLikeNode(snapshot, nodeId)) continue;
        const text = resolveNodeText(nodeId, snapshot);
        if (text) texts.push(text);
      }
    }
    const best = pickMostFrequentText(texts);
    if (best) headers[slot] = best;
  }

  if (Object.keys(headers).length > 0) return headers;

  const containerNode = snapshot.nodeIndex?.[entity.containerId];
  const containerTag = nodeTag(snapshot, entity.containerId);
  const isBodyLike = containerTag === 'tbody' || normalizeText(containerNode?.role)?.toLowerCase() === 'tbody';
  if (!isBodyLike) return headers;

  const parentId = parentNodeIdMap.value[entity.containerId] || '';
  if (!parentId) return headers;
  const tableNode = snapshot.nodeIndex?.[parentId];
  if (!tableNode) return headers;

  const tableRole = normalizeText(tableNode.role)?.toLowerCase() || '';
  const tableTag = nodeTag(snapshot, tableNode.id);
  if (tableRole !== 'table' && tableTag !== 'table') return headers;

  const theadHeaders = extractTheadHeaders(snapshot, tableNode, preview.slots.length);
  for (let i = 0; i < preview.slots.length; i += 1) {
    const slot = preview.slots[i];
    const text = normalizeText(theadHeaders[i]);
    if (!slot && slot !== 0) continue;
    if (text) headers[slot] = text;
  }

  return headers;
});

const selectedFormPreview = computed<FormPreviewRow[]>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  if (!snapshot || !entity || entity.type !== 'region') return [];
  if (!['form', 'dialog', 'panel'].includes(entity.kind)) return [];

  const container = snapshot.nodeIndex?.[entity.nodeId];
  if (!container) return [];

  const rows: FormPreviewRow[] = [];
  for (const child of container.children.slice(0, 60)) {
    const texts = collectReadableTexts(child.id, snapshot, 3, 2);
    if (texts.length === 0) continue;
    rows.push({
      nodeId: child.id,
      field: texts[0],
      value: texts[1] || '',
    });
  }

  return rows;
});

const selectedGroupAssessment = computed(() => {
  const entity = selectedEntity.value;
  if (!entity || entity.type !== 'group') return null;
  return groupAssessmentMap.value.get(entity.id) || null;
});

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const MACHINE_ID_TEXT_PATTERN = /^[a-z][a-z0-9-]*_[0-9a-f]{6,}(?:_[0-9]+)?$/i;
const FORM_LABEL_CLASS_HINTS = ['form-item__label', 'form-label', 'field-label'];
const OPTION_CLASS_HINTS = ['checkbox', 'radio'];
const FORM_CONTROL_ROLES = new Set([
  'textbox',
  'input',
  'combobox',
  'searchbox',
  'spinbutton',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'listbox',
]);
const FORM_CONTROL_TAGS = new Set(['input', 'textarea', 'select']);
const ACTION_CONTROL_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const ACTION_CONTROL_TAGS = new Set(['button', 'a']);

const normalizeTag = (snapshot: SnapshotGraphLike, nodeId: string): string => {
  const attrs = snapshot.attrIndex?.[nodeId] || {};
  const rawTag = typeof attrs.tag === 'string'
    ? attrs.tag
    : typeof attrs.tagName === 'string'
      ? attrs.tagName
      : '';
  return normalizeRole(rawTag);
};

const getNodeClass = (snapshot: SnapshotGraphLike, nodeId: string): string => {
  const attrs = snapshot.attrIndex?.[nodeId] || {};
  const value = typeof attrs.class === 'string' ? attrs.class : '';
  return normalizeRole(value);
};

const getNodeAttrText = (snapshot: SnapshotGraphLike, nodeId: string, key: string): string => {
  const attrs = snapshot.attrIndex?.[nodeId] || {};
  const value = attrs[key];
  return typeof value === 'string' ? value.trim() : '';
};

const readNodeTextDeep = (snapshot: SnapshotGraphLike, nodeId: string): string => {
  const direct = resolveNodeText(nodeId, snapshot);
  if (direct) return direct;
  return firstReadableDescendantText(nodeId, snapshot, 3);
};

const sanitizeLabelText = (value: string): string => {
  const text = normalizeText(value);
  if (!text) return '';
  if (MACHINE_ID_TEXT_PATTERN.test(text)) return '';
  return text;
};

const isFormLabelLikeNode = (snapshot: SnapshotGraphLike, node: TreeNodeLike): boolean => {
  const role = normalizeRole(node.role);
  const cls = getNodeClass(snapshot, node.id);
  const text = sanitizeLabelText(readNodeTextDeep(snapshot, node.id));
  const hasLabelClass = FORM_LABEL_CLASS_HINTS.some((hint) => cls.includes(hint));
  if (hasLabelClass) return Boolean(text);
  if (role !== 'label') return false;
  if (OPTION_CLASS_HINTS.some((hint) => cls.includes(hint))) return false;
  if (!text) return false;
  return true;
};

const toControlKind = (snapshot: SnapshotGraphLike, node: TreeNodeLike): PreviewControl['kind'] | undefined => {
  const role = normalizeRole(node.role);
  const tag = normalizeTag(snapshot, node.id);
  if (ACTION_CONTROL_ROLES.has(role) || ACTION_CONTROL_TAGS.has(tag)) return 'button';
  if (role === 'switch') return 'switch';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'combobox' || role === 'listbox' || tag === 'select') return 'select';
  if (role === 'textbox' || role === 'input' || role === 'searchbox' || role === 'spinbutton' || tag === 'input') {
    const inputType = normalizeRole(getNodeAttrText(snapshot, node.id, 'type'));
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'radio') return 'radio';
    return 'input';
  }
  if (role === 'textarea' || tag === 'textarea') return 'textarea';
  return undefined;
};

const buildControlText = (snapshot: SnapshotGraphLike, node: TreeNodeLike, kind: PreviewControl['kind']): string => {
  if (kind === 'input' || kind === 'select' || kind === 'textarea') {
    const placeholder = getNodeAttrText(snapshot, node.id, 'placeholder');
    if (placeholder) return placeholder;
    const value = getNodeAttrText(snapshot, node.id, 'value');
    if (value) return value;
  }
  return sanitizeLabelText(readNodeTextDeep(snapshot, node.id));
};

const buildControlFromNode = (snapshot: SnapshotGraphLike, node: TreeNodeLike): PreviewControl | undefined => {
  const kind = toControlKind(snapshot, node);
  if (!kind) return undefined;
  const text = buildControlText(snapshot, node, kind);
  if ((kind === 'button' || kind === 'checkbox' || kind === 'radio') && !text) return undefined;
  const cls = getNodeClass(snapshot, node.id);
  return {
    kind,
    text: text || undefined,
    primary: kind === 'button' ? (cls.includes('primary') || cls.includes('--primary')) : undefined,
  };
};

const extractControlsFromNodes = (snapshot: SnapshotGraphLike, roots: TreeNodeLike[]): PreviewControl[] => {
  const out: PreviewControl[] = [];
  const dedupe = new Set<string>();
  const queue: Array<{ node: TreeNodeLike; depth: number }> = roots.map((node) => ({ node, depth: 0 }));
  let visited = 0;
  while (queue.length > 0 && visited < 400) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    const control = buildControlFromNode(snapshot, current.node);
    if (control) {
      const key = `${control.kind}|${control.text || ''}|${control.primary ? '1' : '0'}`;
      if (!dedupe.has(key)) {
        dedupe.add(key);
        out.push(control);
      }
    } else {
      const inlineText = sanitizeLabelText(readNodeTextDeep(snapshot, current.node.id));
      if (inlineText && inlineText.length <= 24 && current.depth <= 1) {
        const key = `text|${inlineText}`;
        if (!dedupe.has(key)) {
          dedupe.add(key);
          out.push({ kind: 'text', text: inlineText });
        }
      }
    }

    if (current.depth >= 2) continue;
    for (const child of current.node.children) {
      queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return out.slice(0, 8);
};

const buildFormRowsFromContainer = (snapshot: SnapshotGraphLike, containerId: string): GroupFormRow[] => {
  const container = snapshot.nodeIndex?.[containerId];
  if (!container || container.children.length === 0) return [];

  const labelIndexes: number[] = [];
  for (let i = 0; i < container.children.length; i += 1) {
    const child = container.children[i];
    if (!child) continue;
    if (!isFormLabelLikeNode(snapshot, child)) continue;
    labelIndexes.push(i);
  }
  if (labelIndexes.length < 2) return [];

  const rows: GroupFormRow[] = [];
  for (let i = 0; i < labelIndexes.length; i += 1) {
    const index = labelIndexes[i];
    const labelNode = container.children[index];
    if (!labelNode) continue;
    const label = sanitizeLabelText(readNodeTextDeep(snapshot, labelNode.id));
    if (!label) continue;

    const nextIndex = labelIndexes[i + 1] ?? container.children.length;
    const segment = container.children.slice(index + 1, nextIndex);
    const controls = extractControlsFromNodes(snapshot, segment);
    rows.push({
      id: labelNode.id,
      label,
      controls,
    });
  }
  return rows;
};

const selectedGroupFormRows = computed<GroupFormRow[]>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  const preview = selectedGroupPreview.value;
  if (!snapshot || !entity || entity.type !== 'group' || !preview) return [];

  const byContainer = buildFormRowsFromContainer(snapshot, entity.containerId);
  if (byContainer.length > 0) return byContainer;

  const rows: GroupFormRow[] = [];
  for (const row of preview.rows) {
    const itemNode = snapshot.nodeIndex?.[row.itemId];
    if (!itemNode) continue;
    const label = sanitizeLabelText((row.slots[entity.keySlot] || row.summary || '').trim());
    if (!label) continue;
    const controls = extractControlsFromNodes(snapshot, [itemNode]);
    rows.push({
      id: row.itemId,
      label,
      controls,
    });
  }
  return rows;
});

const selectedGroupRenderMode = computed<'table' | 'form'>(() => {
  const entity = selectedEntity.value;
  const preview = selectedGroupPreview.value;
  if (!entity || entity.type !== 'group' || !preview) return 'table';
  if (entity.kind === 'table') return 'table';
  if (entity.kind === 'kv') return 'form';

  const formRows = selectedGroupFormRows.value;
  if (formRows.length < 2) return 'table';
  const labeledCount = formRows.filter((row) => row.label.length > 0).length;
  const controlCount = formRows.filter((row) => row.controls.length > 0).length;
  const labeledRate = labeledCount / formRows.length;
  const controlRate = controlCount / formRows.length;
  if (labeledRate >= 0.7 && controlRate >= 0.4) return 'form';
  if (preview.slots.length <= 1 && labeledRate >= 0.65) return 'form';
  return 'table';
});

const rawDomRoot = computed(() => dataPack.value.rawDomTree || null);

const WRAPPER_DOM_TAGS = new Set(['div', 'span', 'section', 'article', 'main', 'aside']);
const RAW_PREVIEW_SAFE_ATTRS = new Set([
  'class',
  'id',
  'role',
  'type',
  'name',
  'placeholder',
  'value',
  'for',
  'href',
  'src',
  'alt',
  'title',
  'style',
  'checked',
  'selected',
  'disabled',
  'readonly',
  'multiple',
  'colspan',
  'rowspan',
]);
const RAW_PREVIEW_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_PREVIEW_BLOCKED_TAGS = new Set(['script', 'noscript']);
const RAW_PREVIEW_NODE_LIMIT = 1500;

const getRawBackendDomId = (node: RawDomNodeLike): string => {
  if (typeof node.backendDOMNodeId === 'string' || typeof node.backendDOMNodeId === 'number') {
    return String(node.backendDOMNodeId);
  }
  const attrs = node.attrs || {};
  const attrId = attrs.backendDOMNodeId;
  if (typeof attrId === 'string' || typeof attrId === 'number') {
    return String(attrId);
  }
  return '';
};

const getRawAttrText = (node: RawDomNodeLike, key: string): string => {
  const attrs = node.attrs || {};
  const value = attrs[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : '';
  return '';
};

const rawDomIndex = computed<RawDomIndex | null>(() => {
  const root = rawDomRoot.value;
  if (!root) return null;

  const byBackendId: Record<string, RawDomNodeLike> = {};
  const parentByBackendId: Record<string, string> = {};
  const stylesheetHrefs: string[] = [];
  const seenStyles = new Set<string>();
  const stack: Array<{ node: RawDomNodeLike; parentId: string }> = [{ node: root, parentId: '' }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const backendId = getRawBackendDomId(current.node);
    if (backendId) {
      byBackendId[backendId] = current.node;
      parentByBackendId[backendId] = current.parentId;
    }

    const tag = normalizeRole(current.node.tag);
    if (tag === 'link') {
      const href = getRawAttrText(current.node, 'href');
      const lower = href.toLowerCase();
      if (href && !seenStyles.has(href) && /\.css($|[?#])/.test(lower)) {
        seenStyles.add(href);
        stylesheetHrefs.push(href);
      }
    }

    const nextParentId = backendId || current.parentId;
    for (let i = current.node.children.length - 1; i >= 0; i -= 1) {
      const child = current.node.children[i];
      if (!child) continue;
      stack.push({ node: child, parentId: nextParentId });
    }
  }

  return {
    byBackendId,
    parentByBackendId,
    stylesheetHrefs,
  };
});

const collectSemanticSubtreeNodeIds = (snapshot: SnapshotGraphLike, rootId: string, out: Set<string>) => {
  const root = snapshot.nodeIndex?.[rootId];
  if (!root) return;
  const stack: TreeNodeLike[] = [root];
  while (stack.length > 0 && out.size < 6000) {
    const current = stack.pop();
    if (!current) break;
    if (out.has(current.id)) continue;
    out.add(current.id);
    for (let i = current.children.length - 1; i >= 0; i -= 1) {
      const child = current.children[i];
      if (child) stack.push(child);
    }
  }
};

const collectEntitySemanticNodeIds = (entity: EntityRecordLike, snapshot: SnapshotGraphLike): Set<string> => {
  const out = new Set<string>();
  if (entity.type === 'group') {
    collectSemanticSubtreeNodeIds(snapshot, entity.containerId, out);
    for (const itemId of entity.itemIds) {
      collectSemanticSubtreeNodeIds(snapshot, itemId, out);
    }
  } else {
    collectSemanticSubtreeNodeIds(snapshot, entity.nodeId, out);
  }
  return out;
};

const collectMappedDomIds = (
  snapshot: SnapshotGraphLike,
  semanticNodeIds: Set<string>,
  rawIndex: RawDomIndex,
): Set<string> => {
  const out = new Set<string>();
  for (const nodeId of semanticNodeIds) {
    const origin = snapshot.locatorIndex?.[nodeId]?.origin;
    if (!origin) continue;
    if (origin.primaryDomId !== undefined && origin.primaryDomId !== null) {
      const primary = String(origin.primaryDomId);
      if (rawIndex.byBackendId[primary]) out.add(primary);
    }
    for (const sourceId of origin.sourceDomIds || []) {
      const source = String(sourceId);
      if (rawIndex.byBackendId[source]) out.add(source);
    }
  }
  return out;
};

const ancestorPath = (start: string, parentByBackendId: Record<string, string>): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = start;
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = parentByBackendId[current] || '';
  }
  return out;
};

const findLcaBackendId = (domIds: string[], parentByBackendId: Record<string, string>): string => {
  if (domIds.length === 0) return '';
  let lca = domIds[0] || '';
  for (let i = 1; i < domIds.length && lca; i += 1) {
    const pathSet = new Set(ancestorPath(domIds[i] || '', parentByBackendId));
    while (lca && !pathSet.has(lca)) {
      lca = parentByBackendId[lca] || '';
    }
  }
  return lca;
};

const subtreeSelectedCount = (root: RawDomNodeLike, selectedDomIds: Set<string>): number => {
  let count = 0;
  const stack: RawDomNodeLike[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const backendId = getRawBackendDomId(current);
    if (backendId && selectedDomIds.has(backendId)) count += 1;
    for (let i = current.children.length - 1; i >= 0; i -= 1) {
      const child = current.children[i];
      if (child) stack.push(child);
    }
  }
  return count;
};

const shrinkWrapperDomRoot = (candidateId: string, selectedDomIds: Set<string>, rawIndex: RawDomIndex): string => {
  let currentId = candidateId;
  for (let guard = 0; guard < 8; guard += 1) {
    const currentNode = rawIndex.byBackendId[currentId];
    if (!currentNode) break;
    const tag = normalizeRole(currentNode.tag);
    const ownText = normalizeText(currentNode.text);
    if (!WRAPPER_DOM_TAGS.has(tag) || ownText) break;

    let onlyChildId = '';
    let childHitCount = 0;
    for (const child of currentNode.children) {
      const childId = getRawBackendDomId(child);
      if (!childId || !rawIndex.byBackendId[childId]) continue;
      const hits = subtreeSelectedCount(child, selectedDomIds);
      if (hits <= 0) continue;
      childHitCount += 1;
      onlyChildId = childId;
      if (childHitCount > 1) break;
    }

    if (childHitCount !== 1 || !onlyChildId) break;
    currentId = onlyChildId;
  }
  return currentId;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeRawTag = (value: string): string => {
  const normalized = normalizeRole(value);
  if (/^[a-z][a-z0-9:-]*$/.test(normalized)) return normalized;
  return 'div';
};

const serializeRawDomNode = (
  node: RawDomNodeLike,
  state: { count: number },
  focusRootId: string,
): string => {
  if (state.count >= RAW_PREVIEW_NODE_LIMIT) return '';
  state.count += 1;

  const tag = sanitizeRawTag(node.tag);
  if (RAW_PREVIEW_BLOCKED_TAGS.has(tag)) return '';

  const attrs: string[] = [];
  const backendId = getRawBackendDomId(node);
  if (backendId) attrs.push(`data-backend-id="${escapeHtml(backendId)}"`);
  if (backendId && backendId === focusRootId) attrs.push('data-focus-root="1"');

  const nodeAttrs = node.attrs || {};
  for (const [key, rawValue] of Object.entries(nodeAttrs)) {
    const attr = key.toLowerCase();
    if (!attr || attr === 'backenddomnodeid' || attr.startsWith('on')) continue;
    const allow = RAW_PREVIEW_SAFE_ATTRS.has(attr) || attr.startsWith('aria-') || attr.startsWith('data-');
    if (!allow) continue;
    if (typeof rawValue === 'boolean') {
      if (rawValue) attrs.push(attr);
      continue;
    }
    if (typeof rawValue === 'string' || typeof rawValue === 'number') {
      const value = String(rawValue).trim();
      if (!value) continue;
      attrs.push(`${attr}="${escapeHtml(value)}"`);
    }
  }

  const attrText = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
  if (RAW_PREVIEW_VOID_TAGS.has(tag)) {
    return `<${tag}${attrText}>`;
  }

  const text = typeof node.text === 'string' ? escapeHtml(node.text) : '';
  let children = '';
  for (const child of node.children) {
    children += serializeRawDomNode(child, state, focusRootId);
    if (state.count >= RAW_PREVIEW_NODE_LIMIT) break;
  }

  return `<${tag}${attrText}>${text}${children}</${tag}>`;
};

const buildDomPreviewSrcdoc = (
  root: RawDomNodeLike,
  focusRootId: string,
  stylesheetHrefs: string[],
  baseUrl: string,
): string => {
  const state = { count: 0 };
  const bodyHtml = serializeRawDomNode(root, state, focusRootId);
  const rootTag = sanitizeRawTag(root.tag);
  const wrappedBodyHtml = wrapDomPreviewRoot(rootTag, bodyHtml);
  const links = stylesheetHrefs
    .slice(0, 16)
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('');
  let base = '';
  try {
    const url = new URL(baseUrl);
    base = `<base href="${escapeHtml(url.href)}">`;
  } catch {
    base = '';
  }

  return `<!doctype html><html><head><meta charset="utf-8">${base}${links}<style>
html, body { margin: 0; padding: 0; background: #fff; }
body { padding: 12px; overflow: auto; }
[data-focus-root="1"] { outline: 2px solid #3b82f6; outline-offset: 2px; }
</style></head><body>${wrappedBodyHtml}</body></html>`;
};

const wrapDomPreviewRoot = (rootTag: string, html: string): string => {
  if (!html) return html;
  if (rootTag === 'tbody' || rootTag === 'thead' || rootTag === 'tfoot') {
    return `<table>${html}</table>`;
  }
  if (rootTag === 'tr') {
    return `<table><tbody>${html}</tbody></table>`;
  }
  if (rootTag === 'td' || rootTag === 'th') {
    return `<table><tbody><tr>${html}</tr></tbody></table>`;
  }
  if (rootTag === 'li') {
    return `<ul>${html}</ul>`;
  }
  if (rootTag === 'option') {
    return `<select>${html}</select>`;
  }
  return html;
};

const selectedEntityDomPreview = computed<EntityDomPreview | null>(() => {
  const snapshot = activeSnapshot.value;
  const entity = selectedEntity.value;
  const rawIndex = rawDomIndex.value;
  if (!snapshot || !entity || !rawIndex) return null;

  const semanticNodeIds = collectEntitySemanticNodeIds(entity, snapshot);
  if (semanticNodeIds.size === 0) return null;
  const domIds = collectMappedDomIds(snapshot, semanticNodeIds, rawIndex);
  if (domIds.size === 0) return null;

  const domIdList = Array.from(domIds);
  const lcaId = findLcaBackendId(domIdList, rawIndex.parentByBackendId);
  if (!lcaId) return null;
  const rootId = shrinkWrapperDomRoot(lcaId, domIds, rawIndex);
  const root = rawIndex.byBackendId[rootId];
  if (!root) return null;

  return {
    rootDomId: rootId,
    mappedDomCount: domIds.size,
    srcdoc: buildDomPreviewSrcdoc(root, rootId, rawIndex.stylesheetHrefs, resolvedUrl.value),
  };
});

const contentRefOf = (node: TreeNodeLike | null): string => {
  if (!node || typeof node.content === 'string') return '';
  return node.content?.ref || '';
};

const selectedContent = computed(() => {
  const node = selectedNode.value;
  const snapshot = activeSnapshot.value;
  if (!node || !snapshot) return '';
  return resolveNodeContent(node, snapshot);
});

const selectedAttrs = computed(() => {
  const node = selectedNode.value;
  const snapshot = activeSnapshot.value;
  if (!node || !snapshot) return {};
  return snapshot.attrIndex?.[node.id] || {};
});

const selectedBbox = computed(() => {
  const node = selectedNode.value;
  const snapshot = activeSnapshot.value;
  if (!node || !snapshot) return {};
  return snapshot.bboxIndex?.[node.id] || {};
});

const summaryRows = computed(() => {
  const snapshot = activeSnapshot.value;
  if (!snapshot) return [] as Array<[string, number]>;
  return [
    ['nodes', Object.keys(snapshot.nodeIndex || {}).length],
    ['regions', regionItems.value.length],
    ['groups', groupItems.value.length],
    ['majorEntities', majorEntityRows.value.length],
    ['bbox', Object.keys(snapshot.bboxIndex || {}).length],
    ['attrs', Object.keys(snapshot.attrIndex || {}).length],
    ['content', Object.keys(snapshot.contentStore || {}).length],
  ] as Array<[string, number]>;
});

const selectedTarget = computed(() => JSON.stringify(selectedNode.value?.target || {}, null, 2));
const selectedAttrsJson = computed(() => JSON.stringify(selectedAttrs.value, null, 2));
const selectedBboxJson = computed(() => JSON.stringify(selectedBbox.value, null, 2));
const toPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const findNodeById = (root: TreeNodeLike, id: string): TreeNodeLike | null => {
  if (root.id === id) return root;
  for (const child of root.children) {
    const matched = findNodeById(child, id);
    if (matched) return matched;
  }
  return null;
};

const selectNodeById = (nodeId: string) => {
  const snapshot = activeSnapshot.value;
  if (!snapshot) return;
  const node = snapshot.nodeIndex?.[nodeId] || (activeRoot.value ? findNodeById(activeRoot.value, nodeId) : null);
  if (!node) return;
  selectedNode.value = node;
};

const selectEntityById = (entityId: string) => {
  if (!entityId) return;
  const entity = activeEntityIndex.value.entities[entityId];
  if (!entity) return;
  selectedEntityId.value = entityId;
};

const applySnapshotPayload = (
  payload: SnapshotApiResponse,
  fallbackUrl: string,
  rawDomTree?: RawDomNodeLike | null,
) => {
  if (!payload.ok || !payload.data) {
    throw new Error(payload.error || 'invalid snapshot payload');
  }

  const snapshot = normalizeSnapshot(payload.data.unifiedGraph);
  if (!snapshot) {
    throw new Error('snapshot payload has no valid root');
  }

  const payloadRawDomTree = normalizeRawDomTree(payload.data.raw?.domTree);
  const resolvedRawDomTree = rawDomTree === undefined ? payloadRawDomTree : rawDomTree;

  dataPack.value = {
    snapshot,
    rawDomTree: resolvedRawDomTree || null,
  };
  resolvedUrl.value = payload.data.url || fallbackUrl;
  selectedNode.value = null;
  selectedEntityId.value = '';
};

const fetchSnapshot = async () => {
  error.value = '';
  const url = targetUrl.value.trim();
  if (!url) {
    error.value = '请输入 URL';
    return;
  }

  loading.value = true;
  try {
    const response = await fetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const payload = (await response.json()) as SnapshotApiResponse;
    if (!response.ok) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }
    applySnapshotPayload(payload, url);
  } catch (cause) {
    error.value = `抓取失败: ${String(cause)}`;
  } finally {
    loading.value = false;
  }
};

const fetchCaptureList = async () => {
  captureLoading.value = true;
  try {
    const response = await fetch('/api/capture/list');
    const payload = (await response.json()) as CaptureListApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }

    captures.value = payload.data.items || [];
    captureStoreDir.value = payload.data.storeDir || '';
  } catch (cause) {
    error.value = `加载采集列表失败: ${String(cause)}`;
  } finally {
    captureLoading.value = false;
  }
};

const applyCaptureEnvelope = async (envelope: CaptureEnvelope) => {
  const rawDomTree = normalizeRawDomTree(envelope.raw?.domTree);
  if (envelope.snapshot) {
    applySnapshotPayload(
      {
        ok: true,
        data: {
          url: envelope.finalUrl || envelope.sourceUrl || `capture://${envelope.label}`,
          unifiedGraph: envelope.snapshot,
        },
      },
      envelope.finalUrl || envelope.sourceUrl || `capture://${envelope.label}`,
      rawDomTree,
    );
    return;
  }

  if (envelope.raw?.domTree && envelope.raw?.a11yTree) {
    const response = await fetch('/api/snapshot/from-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domTree: envelope.raw.domTree,
        a11yTree: envelope.raw.a11yTree,
        label: envelope.label,
      }),
    });
    const payload = (await response.json()) as SnapshotApiResponse;
    if (!response.ok) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }
    applySnapshotPayload(
      payload,
      envelope.finalUrl || envelope.sourceUrl || `capture://${envelope.label}`,
      rawDomTree,
    );
    return;
  }

  throw new Error('capture 中没有 snapshot 或 raw 数据');
};

const loadCapture = async (id: string) => {
  if (!id) return;
  error.value = '';
  loading.value = true;
  try {
    const response = await fetch(`/api/capture/item?id=${encodeURIComponent(id)}`);
    const payload = (await response.json()) as CaptureItemApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }
    selectedCaptureId.value = payload.data.id;
    await applyCaptureEnvelope(payload.data);
  } catch (cause) {
    error.value = `加载采集数据失败: ${String(cause)}`;
  } finally {
    loading.value = false;
  }
};

const loadLatestCapture = async () => {
  await fetchCaptureList();
  const latest = captures.value[0];
  if (!latest) {
    error.value = '当前没有采集记录';
    return;
  }
  await loadCapture(latest.id);
};

const onSelect = (node: TreeNodeLike) => {
  selectedNode.value = node;
};

const hideContextMenu = () => {
  contextMenu.value.visible = false;
};

const onTreeContextMenu = (event: MouseEvent) => {
  event.preventDefault();
  if (!activeRoot.value) return;
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    node: selectedNode.value || activeRoot.value,
  };
};

const onNodeContextMenu = (payload: { node: TreeNodeLike; x: number; y: number }) => {
  contextMenu.value = {
    visible: true,
    x: payload.x,
    y: payload.y,
    node: payload.node,
  };
};

const serializeTreeNode = (node: TreeNodeLike): unknown => ({
  id: node.id,
  role: node.role,
  name: node.name,
  content: node.content,
  target: node.target,
  children: node.children.map((child) => serializeTreeNode(child)),
});

const findNodePath = (root: TreeNodeLike, targetId: string): string[] => {
  const path: string[] = [];
  const walkPath = (node: TreeNodeLike): boolean => {
    path.push(node.id);
    if (node.id === targetId) return true;
    for (const child of node.children) {
      if (walkPath(child)) return true;
    }
    path.pop();
    return false;
  };
  return walkPath(root) ? path : [];
};

const copyText = async (value: string, successLabel: string) => {
  try {
    await navigator.clipboard.writeText(value);
    copyMessage.value = successLabel;
  } catch {
    copyMessage.value = '复制失败：浏览器不允许访问剪贴板';
  } finally {
    setTimeout(() => {
      copyMessage.value = '';
    }, 1600);
  }
};

const copyCurrentTree = async () => {
  if (!activeSnapshot.value) return;
  await copyText(JSON.stringify(activeSnapshot.value, null, 2), '已复制完整 snapshot JSON');
  hideContextMenu();
};

const copyCurrentNode = async () => {
  const node = contextMenu.value.node || selectedNode.value;
  if (!node) return;
  const payload = {
    node: serializeTreeNode(node),
    attrs: activeSnapshot.value?.attrIndex?.[node.id] || {},
    bbox: activeSnapshot.value?.bboxIndex?.[node.id] || {},
    locator: activeSnapshot.value?.locatorIndex?.[node.id] || {},
  };
  await copyText(JSON.stringify(payload, null, 2), '已复制当前节点详情');
  hideContextMenu();
};

const copyCurrentNodePath = async () => {
  const root = activeRoot.value;
  const node = contextMenu.value.node || selectedNode.value;
  if (!root || !node) return;
  const path = findNodePath(root, node.id);
  if (path.length === 0) return;
  await copyText(path.join(' > '), '已复制节点路径');
  hideContextMenu();
};

const copyCurrentTargetRef = async () => {
  const node = contextMenu.value.node || selectedNode.value;
  const targetRef = node?.target?.ref;
  if (!targetRef) return;
  await copyText(targetRef, '已复制 target.ref');
  hideContextMenu();
};

const copyCurrentNodeNameOrContent = async () => {
  const node = contextMenu.value.node || selectedNode.value;
  if (!node) return;
  const snapshot = activeSnapshot.value;
  const value = node.name || (snapshot ? resolveNodeContent(node, snapshot) : '');
  if (!value) return;
  await copyText(value, '已复制节点 name/content');
  hideContextMenu();
};

onMounted(() => {
  void fetchCaptureList();
  capturePollTimer = window.setInterval(() => {
    void fetchCaptureList();
  }, 3000);

  window.addEventListener('click', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
});

onBeforeUnmount(() => {
  if (capturePollTimer) {
    window.clearInterval(capturePollTimer);
    capturePollTimer = null;
  }

  window.removeEventListener('click', hideContextMenu);
  window.removeEventListener('resize', hideContextMenu);
  window.removeEventListener('scroll', hideContextMenu, true);
});
</script>

<template>
  <div class="panel">
    <div class="section">
      <h2>Fetch Snapshot</h2>
      <input v-model="targetUrl" placeholder="https://example.com" />
      <button :disabled="loading" @click="fetchSnapshot">
        {{ loading ? '抓取中...' : '抓取真实页面' }}
      </button>
    </div>

    <div class="section">
      <h2>Test Captures</h2>
      <div class="row">
        <button :disabled="captureLoading" @click="fetchCaptureList">
          {{ captureLoading ? '刷新中...' : '刷新采集列表' }}
        </button>
        <button :disabled="loading || captures.length === 0" @click="loadLatestCapture">
          {{ loading ? '加载中...' : '加载最新采集' }}
        </button>
      </div>
      <div v-if="captureStoreDir" class="muted">store: {{ captureStoreDir }}</div>
      <div v-if="captures.length === 0" class="muted">暂无采集数据</div>
      <div v-else class="entity-list">
        <button
          v-for="capture in captures"
          :key="capture.id"
          class="entity-item"
          :class="{ selected: selectedCaptureId === capture.id }"
          @click="loadCapture(capture.id)"
        >
          <div class="entity-top">
            <span class="badge">{{ capture.hasSnapshot ? 'snapshot' : 'raw' }}</span>
            <span class="entity-id">{{ capture.label }}</span>
          </div>
          <div class="entity-label">{{ capture.title || capture.finalUrl || capture.sourceUrl || '(untitled)' }}</div>
          <div class="entity-metrics">{{ capture.capturedAt }}</div>
        </button>
      </div>
    </div>

    <div class="section">
      <div v-if="resolvedUrl" class="muted">当前数据：{{ resolvedUrl }}</div>
      <div v-if="error" class="error-text">{{ error }}</div>
    </div>
  </div>

  <div class="panel middle-panel">
    <div class="section">
      <h2>Center View</h2>
      <div class="mode-switch">
        <button class="secondary mode-btn" :class="{ active: centerMode === 'entities' }" @click="centerMode = 'entities'">
          Entities
        </button>
        <button class="secondary mode-btn" :class="{ active: centerMode === 'tree' }" @click="centerMode = 'tree'">
          Tree
        </button>
      </div>
    </div>

    <template v-if="centerMode === 'entities'">
      <div class="section">
        <h2>Structure Preview</h2>
        <div v-if="!selectedEntity" class="muted">click one entity in list below</div>

        <template v-else-if="selectedEntityDomPreview">
          <div class="kv"><span class="k">render</span><span>raw-dom</span></div>
          <div class="kv"><span class="k">domRoot</span><span>{{ selectedEntityDomPreview.rootDomId }}</span></div>
          <div class="kv"><span class="k">mapped</span><span>{{ selectedEntityDomPreview.mappedDomCount }}</span></div>
          <iframe
            class="entity-dom-frame"
            :srcdoc="selectedEntityDomPreview.srcdoc"
            sandbox="allow-same-origin"
          />
        </template>

        <template v-else-if="selectedEntity.type === 'group' && selectedGroupPreview">
          <div class="kv"><span class="k">kind</span><span>{{ selectedEntity.kind }}</span></div>
          <div class="kv"><span class="k">keySlot</span><span>slot {{ selectedEntity.keySlot }}</span></div>
          <div class="kv"><span class="k">items</span><span>{{ selectedEntity.itemIds.length }}</span></div>

          <table v-if="selectedGroupRenderMode === 'table'" class="preview-table">
            <thead>
              <tr>
                <th>#</th>
                <th v-for="slot in selectedGroupPreview.slots" :key="slot" :class="{ key: slot === selectedEntity.keySlot }">
                  {{ selectedGroupColumnHeaders[slot] || `col ${slot + 1}` }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in selectedGroupPreview.rows" :key="row.itemId">
                <td class="mono">{{ rowIndex + 1 }}</td>
                <td
                  v-for="slot in selectedGroupPreview.slots"
                  :key="`${row.itemId}_${slot}`"
                  :class="{ key: slot === selectedEntity.keySlot }"
                >
                  {{ row.slots[slot] || '-' }}
                </td>
              </tr>
            </tbody>
          </table>

          <div v-else class="form-preview">
            <div v-for="row in selectedGroupFormRows" :key="row.id" class="form-row">
              <div class="form-field">{{ row.label || '(field)' }}</div>
              <div class="form-value">
                <div v-if="row.controls.length === 0">-</div>
                <div v-else class="form-controls">
                  <template v-for="(control, controlIndex) in row.controls" :key="`${row.id}_${controlIndex}_${control.kind}`">
                    <button
                      v-if="control.kind === 'button'"
                      class="preview-button"
                      :class="{ primary: control.primary }"
                    >
                      {{ control.text || 'Button' }}
                    </button>
                    <label v-else-if="control.kind === 'checkbox' || control.kind === 'radio'" class="preview-choice">
                      <span class="choice-icon" :class="control.kind"></span>
                      <span>{{ control.text || (control.kind === 'checkbox' ? 'Option' : 'Choice') }}</span>
                    </label>
                    <span v-else-if="control.kind === 'switch'" class="preview-switch">
                      <span class="switch-dot"></span>
                    </span>
                    <span v-else-if="control.kind === 'select'" class="preview-input select">
                      <span>{{ control.text || 'Please select' }}</span>
                      <span class="select-arrow">▾</span>
                    </span>
                    <span v-else-if="control.kind === 'textarea'" class="preview-input textarea">
                      {{ control.text || 'Please input' }}
                    </span>
                    <span v-else-if="control.kind === 'text'" class="preview-inline">{{ control.text }}</span>
                    <span v-else class="preview-input">{{ control.text || 'Please input' }}</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="selectedEntity.type === 'region'">
          <div class="kv"><span class="k">kind</span><span>{{ selectedEntity.kind }}</span></div>
          <div class="kv"><span class="k">node</span><span>{{ selectedEntity.nodeId }}</span></div>
          <div v-if="selectedFormPreview.length > 0" class="form-preview">
            <div v-for="row in selectedFormPreview" :key="row.nodeId" class="form-row">
              <div class="form-field">{{ row.field }}</div>
              <div class="form-value">{{ row.value || '-' }}</div>
            </div>
          </div>
          <div v-else class="muted">当前 region 无法稳定渲染为表单，回退为 Tree 高亮查看</div>
        </template>
      </div>

      <div class="section">
        <h2>Entity List</h2>
        <div v-if="majorEntityRows.length === 0" class="muted">no entities</div>
        <div v-else class="entity-scroll-list">
          <button
            v-for="row in majorEntityRows"
            :key="row.id"
            class="entity-item"
            :class="{ selected: row.id === selectedEntityId }"
            @click="selectEntityById(row.id)"
          >
            <div class="entity-top">
              <span class="badge">{{ row.type }}/{{ row.kind }}</span>
              <span class="entity-id">{{ row.id }}</span>
            </div>
            <div class="entity-label">{{ row.label }}</div>
            <div class="entity-metrics">
              count={{ row.type === 'group' ? row.itemCount : row.size }}
              <span v-if="row.type === 'group'"> keySlot={{ row.keySlot ?? 0 }} score={{ toPercent(row.score || 0) }}</span>
            </div>
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="section">
        <h2>Tree</h2>
        <div v-if="selectedEntity" class="muted">entity={{ selectedEntity.id }} ({{ selectedEntity.type }}/{{ selectedEntity.kind }})</div>
        <label class="toggle-line">
          <input v-model="focusEntityTree" type="checkbox" />
          <span>树仅显示当前实体子树</span>
        </label>
      </div>

      <div class="tree-wrap" @contextmenu="onTreeContextMenu">
        <TreeNode
          v-if="activeTreeRoot"
          :node="activeTreeRoot"
          :selected-id="selectedNode?.id || ''"
          :highlight-id-map="highlightIdMap"
          @select="onSelect"
          @contextmenu-node="onNodeContextMenu"
        />
        <div v-else class="muted">no tree data</div>
      </div>
    </template>
  </div>

  <div class="panel">
    <div class="section">
      <h2>Snapshot Overview</h2>
      <div v-if="summaryRows.length === 0" class="muted">no snapshot loaded</div>
      <div v-else>
        <div v-for="row in summaryRows" :key="row[0]" class="kv">
          <span class="k">{{ row[0] }}</span>
          <span>{{ row[1] }}</span>
        </div>
      </div>
      <div v-if="activeSnapshot?.cacheStats" class="muted">
        cache: total={{ activeSnapshot.cacheStats.bucketTotal }} hit={{ activeSnapshot.cacheStats.bucketHit }} miss={{ activeSnapshot.cacheStats.bucketMiss }}
      </div>
    </div>

    <div class="section">
      <h2>Entity Detail</h2>
      <div v-if="!selectedEntity" class="muted">click one entity in Entity View</div>
      <template v-else>
        <div class="kv"><span class="k">id</span><span>{{ selectedEntity.id }}</span></div>
        <div class="kv"><span class="k">type</span><span>{{ selectedEntity.type }}</span></div>
        <div class="kv"><span class="k">kind</span><span>{{ selectedEntity.kind }}</span></div>
        <div v-if="selectedEntity.type === 'group'" class="kv"><span class="k">keySlot</span><span>{{ selectedEntity.keySlot }}</span></div>
        <div v-if="selectedEntity.type === 'group'" class="kv"><span class="k">items</span><span>{{ selectedEntity.itemIds.length }}</span></div>
        <div v-if="selectedEntity.type === 'group' && selectedGroupAssessment" class="kv"><span class="k">score</span><span>{{ toPercent(selectedGroupAssessment.score) }}</span></div>
        <div v-if="selectedEntity.type === 'group' && selectedGroupAssessment && selectedGroupAssessment.sampleKeys.length > 0" class="kv">
          <span class="k">sampleKeys</span><span>{{ selectedGroupAssessment.sampleKeys.join(' | ') }}</span>
        </div>
        <div v-if="selectedEntityRow" class="kv"><span class="k">label</span><span>{{ selectedEntityRow.label }}</span></div>
      </template>
    </div>

    <div v-if="selectedNode" class="section">
      <h2>Node Detail</h2>
      <div class="kv"><span class="k">id</span><span>{{ selectedNode.id }}</span></div>
      <div class="kv"><span class="k">role</span><span>{{ selectedNode.role || '-' }}</span></div>
      <div class="kv"><span class="k">name</span><span>{{ selectedNode.name || '-' }}</span></div>
      <div class="kv"><span class="k">content</span><span>{{ typeof selectedNode.content === 'string' ? selectedNode.content : selectedNode.content?.ref || '-' }}</span></div>
      <div class="kv"><span class="k">contentResolved</span><span>{{ selectedContent || '-' }}</span></div>
      <div class="kv"><span class="k">contentRef</span><span>{{ contentRefOf(selectedNode) || '-' }}</span></div>
      <div class="kv"><span class="k">target</span></div>
      <pre>{{ selectedTarget }}</pre>
      <div class="kv"><span class="k">bboxIndex</span></div>
      <pre>{{ selectedBboxJson }}</pre>
      <div class="kv"><span class="k">attrIndex</span></div>
      <pre>{{ selectedAttrsJson }}</pre>
    </div>
    <div v-else class="section">
      <h2>Node Detail</h2>
      <div class="muted">click one node in tree</div>
    </div>
  </div>

  <div
    v-if="contextMenu.visible"
    class="context-menu"
    :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    @click.stop
  >
    <button class="context-item" @click="copyCurrentTree">复制完整 snapshot JSON</button>
    <button class="context-item" @click="copyCurrentNode">复制当前节点详情</button>
    <button class="context-item" @click="copyCurrentNodePath">复制节点路径</button>
    <button class="context-item" @click="copyCurrentNodeNameOrContent">复制 name/content</button>
    <button class="context-item" :disabled="!(contextMenu.node?.target?.ref || selectedNode?.target?.ref)" @click="copyCurrentTargetRef">
      复制 target.ref
    </button>
  </div>

  <div v-if="copyMessage" class="copy-toast">{{ copyMessage }}</div>
</template>
