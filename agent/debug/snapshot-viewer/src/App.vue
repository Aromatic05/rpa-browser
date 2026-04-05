<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type {
  CaptureEnvelope,
  CaptureItemApiResponse,
  CaptureListApiResponse,
  CaptureListItem,
  Content,
  DataPack,
  EntityLike,
  LocatorLike,
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
    entityIndex:
      maybe.entityIndex && typeof maybe.entityIndex === 'object'
        ? (maybe.entityIndex as Record<string, EntityLike>)
        : {},
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

const activeSnapshot = computed(() => dataPack.value.snapshot);
const activeRoot = computed(() => dataPack.value.snapshot?.root || null);
const entityItems = computed(() => Object.values(activeSnapshot.value?.entityIndex || {}));
const locatorItems = computed(() =>
  Object.entries(activeSnapshot.value?.locatorIndex || {}).map(([nodeId, locator]) => ({ nodeId, locator })),
);

const resolveNodeContent = (node: TreeNodeLike, snapshot: SnapshotGraphLike): string => {
  if (typeof node.content === 'string') return node.content;
  if (node.content?.ref) return snapshot.contentStore?.[node.content.ref] || '';
  return '';
};

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

const selectedLocator = computed(() => {
  const node = selectedNode.value;
  const snapshot = activeSnapshot.value;
  if (!node || !snapshot) return {};
  return snapshot.locatorIndex?.[node.id] || {};
});

const selectedEntity = computed(() => {
  const node = selectedNode.value;
  const snapshot = activeSnapshot.value;
  if (!node || !snapshot) return null;
  return (
    Object.values(snapshot.entityIndex || {}).find((entity) => entity.nodeId === node.id) ||
    null
  );
});

const summaryRows = computed(() => {
  const snapshot = activeSnapshot.value;
  if (!snapshot) return [];
  return [
    ['nodes', Object.keys(snapshot.nodeIndex || {}).length],
    ['entities', Object.keys(snapshot.entityIndex || {}).length],
    ['locators', Object.keys(snapshot.locatorIndex || {}).length],
    ['bbox', Object.keys(snapshot.bboxIndex || {}).length],
    ['attrs', Object.keys(snapshot.attrIndex || {}).length],
    ['content', Object.keys(snapshot.contentStore || {}).length],
  ];
});

const selectedTarget = computed(() => JSON.stringify(selectedNode.value?.target || {}, null, 2));
const selectedAttrsJson = computed(() => JSON.stringify(selectedAttrs.value, null, 2));
const selectedBboxJson = computed(() => JSON.stringify(selectedBbox.value, null, 2));
const selectedLocatorJson = computed(() => JSON.stringify(selectedLocator.value, null, 2));
const selectedEntityJson = computed(() => JSON.stringify(selectedEntity.value || {}, null, 2));

const findNodeById = (root: TreeNodeLike, id: string): TreeNodeLike | null => {
  if (root.id === id) return root;
  for (const child of root.children) {
    const matched = findNodeById(child, id);
    if (matched) return matched;
  }
  return null;
};

const applySnapshotPayload = (payload: SnapshotApiResponse, fallbackUrl: string) => {
  if (!payload.ok || !payload.data) {
    throw new Error(payload.error || 'invalid snapshot payload');
  }

  const snapshot = normalizeSnapshot(payload.data.unifiedGraph);
  if (!snapshot) {
    throw new Error('snapshot payload has no valid root');
  }

  dataPack.value = {
    snapshot,
  };
  resolvedUrl.value = payload.data.url || fallbackUrl;
  selectedNode.value = null;
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
    applySnapshotPayload(payload, envelope.finalUrl || envelope.sourceUrl || `capture://${envelope.label}`);
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

const selectEntity = (entity: EntityLike) => {
  if (!activeRoot.value) return;
  const node = findNodeById(activeRoot.value, entity.nodeId);
  if (!node) return;
  selectedNode.value = node;
};

const selectLocatorNode = (nodeId: string) => {
  if (!activeRoot.value) return;
  const node = findNodeById(activeRoot.value, nodeId);
  if (!node) return;
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

  <div class="panel">
    <div class="section">
      <h2>Tree</h2>
    </div>

    <div class="tree-wrap" @contextmenu="onTreeContextMenu">
      <TreeNode
        v-if="activeRoot"
        :node="activeRoot"
        :selected-id="selectedNode?.id || ''"
        @select="onSelect"
        @contextmenu-node="onNodeContextMenu"
      />
      <div v-else class="muted">no tree data</div>
    </div>
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
      <div class="kv"><span class="k">locatorIndex</span></div>
      <pre>{{ selectedLocatorJson }}</pre>
      <div class="kv"><span class="k">entity</span></div>
      <pre>{{ selectedEntityJson }}</pre>
    </div>
    <div v-else class="section">
      <h2>Node Detail</h2>
      <div class="muted">click one node in tree</div>
    </div>

    <div class="section">
      <h2>Entity Index</h2>
      <div v-if="entityItems.length === 0" class="muted">no entity index</div>
      <div v-else class="entity-list">
        <button
          v-for="entity in entityItems"
          :key="entity.id"
          class="entity-item"
          @click="selectEntity(entity)"
        >
          <div class="entity-top">
            <span class="badge">{{ entity.kind }}</span>
            <span class="entity-id">{{ entity.id }}</span>
          </div>
          <div class="entity-label">{{ entity.name || '(unnamed)' }}</div>
          <div class="entity-metrics">node={{ entity.nodeId }}</div>
        </button>
      </div>
    </div>

    <div class="section">
      <h2>Locator Index</h2>
      <div v-if="locatorItems.length === 0" class="muted">no locator index</div>
      <div v-else class="entity-list">
        <button
          v-for="item in locatorItems.slice(0, 120)"
          :key="item.nodeId"
          class="entity-item"
          @click="selectLocatorNode(item.nodeId)"
        >
          <div class="entity-top">
            <span class="badge">{{ item.locator.direct?.kind || 'origin' }}</span>
            <span class="entity-id">{{ item.nodeId }}</span>
          </div>
          <div class="entity-label">{{ item.locator.direct?.query || item.locator.origin.primaryDomId }}</div>
          <div class="entity-metrics">scope={{ item.locator.scope?.id || '-' }}</div>
        </button>
      </div>
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
