<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type { DataPack, SnapshotApiResponse, SourceKind, TreeNodeLike } from './types';

type DetectedEntity = {
  entityId: string;
  entityType: string;
  nodeId: string;
  label: string;
  fieldCount: number;
  actionCount: number;
};

const source = ref<SourceKind>('unifiedGraph');
const error = ref('');
const loading = ref(false);
const targetUrl = ref('https://example.com');
const resolvedUrl = ref('');
const selectedNode = ref<TreeNodeLike | null>(null);
const copyMessage = ref('');

const localLabel = ref('local-fixture');
const localDomTree = ref<unknown | null>(null);
const localA11yTree = ref<unknown | null>(null);
const localDomName = ref('');
const localA11yName = ref('');
const localRawName = ref('');

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
  domTree: null,
  a11yTree: null,
  unifiedGraph: null,
});

const normalizeNode = (value: unknown, fallbackId = 'n0'): TreeNodeLike | null => {
  if (!value || typeof value !== 'object') return null;

  const maybeRecord = value as Record<string, unknown>;
  const id = typeof maybeRecord.id === 'string' ? maybeRecord.id : fallbackId;

  const rawChildren = Array.isArray(maybeRecord.children) ? maybeRecord.children : [];
  const children = rawChildren
    .map((child, index) => normalizeNode(child, `${id}.${index}`))
    .filter((node): node is TreeNodeLike => Boolean(node));

  return {
    id,
    role: typeof maybeRecord.role === 'string' ? maybeRecord.role : undefined,
    tag: typeof maybeRecord.tag === 'string' ? maybeRecord.tag : undefined,
    name: typeof maybeRecord.name === 'string' ? maybeRecord.name : undefined,
    content:
      typeof maybeRecord.content === 'string'
        ? maybeRecord.content
        : typeof maybeRecord.text === 'string'
          ? maybeRecord.text
          : undefined,
    text: typeof maybeRecord.text === 'string' ? maybeRecord.text : undefined,
    target:
      maybeRecord.target && typeof maybeRecord.target === 'object'
        ? (maybeRecord.target as { ref?: string; kind?: string })
        : undefined,
    bbox:
      maybeRecord.bbox &&
      typeof maybeRecord.bbox === 'object' &&
      typeof (maybeRecord.bbox as Record<string, unknown>).x === 'number' &&
      typeof (maybeRecord.bbox as Record<string, unknown>).y === 'number' &&
      typeof (maybeRecord.bbox as Record<string, unknown>).width === 'number' &&
      typeof (maybeRecord.bbox as Record<string, unknown>).height === 'number'
        ? (maybeRecord.bbox as { x: number; y: number; width: number; height: number })
        : undefined,
    attrs:
      maybeRecord.attrs && typeof maybeRecord.attrs === 'object'
        ? (maybeRecord.attrs as Record<string, unknown>)
        : undefined,
    children,
  };
};

const activeRoot = computed(() => {
  const raw = dataPack.value[source.value as keyof DataPack];
  if (!raw) return null;

  const graphRoot =
    source.value === 'unifiedGraph' && typeof raw === 'object' && raw && 'root' in (raw as object)
      ? (raw as { root: unknown }).root
      : raw;

  return normalizeNode(graphRoot, 'n0');
});

const unifiedRoot = computed(() => {
  const raw = dataPack.value.unifiedGraph;
  if (!raw || typeof raw !== 'object') return null;
  if (!('root' in (raw as object))) return null;
  return normalizeNode((raw as { root: unknown }).root, 'n0');
});

const walk = (node: TreeNodeLike, visitor: (node: TreeNodeLike) => void) => {
  visitor(node);
  for (const child of node.children) {
    walk(child, visitor);
  }
};

const nodeText = (node: TreeNodeLike): string => {
  return (node.name || node.content || node.text || '').trim();
};

const findNodeById = (root: TreeNodeLike, id: string): TreeNodeLike | null => {
  if (root.id === id) return root;
  for (const child of root.children) {
    const matched = findNodeById(child, id);
    if (matched) return matched;
  }
  return null;
};

const countByPredicate = (root: TreeNodeLike, predicate: (node: TreeNodeLike) => boolean): number => {
  let count = 0;
  walk(root, (node) => {
    if (predicate(node)) count += 1;
  });
  return count;
};

const detectedEntities = computed<DetectedEntity[]>(() => {
  if (!unifiedRoot.value) return [];
  const entities: DetectedEntity[] = [];

  walk(unifiedRoot.value, (node) => {
    const attrs = node.attrs || {};
    const entityId = typeof attrs.entityId === 'string' ? attrs.entityId : '';
    const entityType = typeof attrs.entityType === 'string' ? attrs.entityType : '';
    if (!entityId || !entityType) return;

    const label =
      nodeText(node) ||
      (typeof attrs.fieldLabel === 'string' ? attrs.fieldLabel : '') ||
      node.id;

    const fieldCount = countByPredicate(node, (n) => typeof n.attrs?.fieldLabel === 'string');
    const actionCount = countByPredicate(node, (n) => typeof n.attrs?.actionIntent === 'string');

    entities.push({
      entityId,
      entityType,
      nodeId: node.id,
      label,
      fieldCount,
      actionCount,
    });
  });

  return entities.sort((a, b) => a.entityId.localeCompare(b.entityId));
});

const selectedAttrs = computed(() => JSON.stringify(selectedNode.value?.attrs || {}, null, 2));
const selectedTarget = computed(() => JSON.stringify(selectedNode.value?.target || {}, null, 2));
const selectedBbox = computed(() => JSON.stringify(selectedNode.value?.bbox || {}, null, 2));

const applySnapshotPayload = (payload: SnapshotApiResponse, fallbackUrl: string) => {
  if (!payload.ok || !payload.data) {
    throw new Error(payload.error || 'invalid snapshot payload');
  }

  dataPack.value = {
    domTree: payload.data.domTree || null,
    a11yTree: payload.data.a11yTree || null,
    unifiedGraph: payload.data.unifiedGraph || null,
  };
  resolvedUrl.value = payload.data.url || fallbackUrl;
  selectedNode.value = null;
  source.value = 'unifiedGraph';
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

const readJsonFile = async (file: File): Promise<unknown> => {
  const text = await file.text();
  return JSON.parse(text);
};

const onLocalDomFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    localDomTree.value = await readJsonFile(file);
    localDomName.value = file.name;
    dataPack.value.domTree = localDomTree.value;
    error.value = '';
  } catch (cause) {
    error.value = `DOM 文件解析失败: ${String(cause)}`;
  }
};

const onLocalA11yFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    localA11yTree.value = await readJsonFile(file);
    localA11yName.value = file.name;
    dataPack.value.a11yTree = localA11yTree.value;
    error.value = '';
  } catch (cause) {
    error.value = `A11y 文件解析失败: ${String(cause)}`;
  }
};

const onLocalRawFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const raw = (await readJsonFile(file)) as Record<string, unknown>;
    if (!raw.domTree || !raw.a11yTree) {
      throw new Error('raw 文件需要包含 domTree 和 a11yTree');
    }

    localDomTree.value = raw.domTree;
    localA11yTree.value = raw.a11yTree;
    localRawName.value = file.name;
    localDomName.value = `${file.name}#domTree`;
    localA11yName.value = `${file.name}#a11yTree`;

    dataPack.value.domTree = localDomTree.value;
    dataPack.value.a11yTree = localA11yTree.value;
    error.value = '';
  } catch (cause) {
    error.value = `RAW 文件解析失败: ${String(cause)}`;
  }
};

const buildSnapshotFromLocal = async () => {
  error.value = '';
  if (!localDomTree.value || !localA11yTree.value) {
    error.value = '请先提供本地 DOM + A11y JSON';
    return;
  }

  loading.value = true;
  try {
    const response = await fetch('/api/snapshot/from-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domTree: localDomTree.value,
        a11yTree: localA11yTree.value,
        label: localLabel.value.trim() || 'local-fixture',
      }),
    });

    const payload = (await response.json()) as SnapshotApiResponse;
    if (!response.ok) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }
    applySnapshotPayload(payload, `local://${localLabel.value.trim() || 'local-fixture'}`);
  } catch (cause) {
    error.value = `本地构建失败: ${String(cause)}`;
  } finally {
    loading.value = false;
  }
};

const onSelect = (node: TreeNodeLike) => {
  selectedNode.value = node;
};

const selectEntity = (entity: DetectedEntity) => {
  if (!unifiedRoot.value) return;
  const node = findNodeById(unifiedRoot.value, entity.nodeId);
  if (!node) return;

  source.value = 'unifiedGraph';
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
  tag: node.tag,
  name: node.name,
  content: node.content,
  target: node.target,
  bbox: node.bbox,
  attrs: node.attrs,
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
  if (!activeRoot.value) return;
  await copyText(JSON.stringify(serializeTreeNode(activeRoot.value), null, 2), '已复制整棵树 JSON');
  hideContextMenu();
};

const copyCurrentNode = async () => {
  const node = contextMenu.value.node || selectedNode.value;
  if (!node) return;
  await copyText(JSON.stringify(serializeTreeNode(node), null, 2), '已复制当前节点 JSON');
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
  const value = node.name || node.content || node.text || '';
  if (!value) return;
  await copyText(value, '已复制节点 name/content');
  hideContextMenu();
};

onMounted(() => {
  window.addEventListener('click', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('click', hideContextMenu);
  window.removeEventListener('resize', hideContextMenu);
  window.removeEventListener('scroll', hideContextMenu, true);
});
</script>

<template>
  <div class="panel">
    <div class="section">
      <h2>Data Source</h2>
      <select v-model="source">
        <option value="domTree">DOM tree</option>
        <option value="a11yTree">A11y tree</option>
        <option value="unifiedGraph">Unified graph</option>
      </select>
    </div>

    <div class="section">
      <h2>Fetch Snapshot</h2>
      <input v-model="targetUrl" placeholder="https://example.com" />
      <button :disabled="loading" @click="fetchSnapshot">
        {{ loading ? '抓取中...' : '抓取真实页面' }}
      </button>
    </div>

    <div class="section">
      <h2>Local DOM/A11y</h2>
      <input v-model="localLabel" placeholder="fixture name" />
      <label class="muted">RAW JSON (domTree + a11yTree)</label>
      <input type="file" accept="application/json" @change="onLocalRawFileChange" />
      <div v-if="localRawName" class="muted">raw: {{ localRawName }}</div>

      <label class="muted">DOM JSON</label>
      <input type="file" accept="application/json" @change="onLocalDomFileChange" />
      <div v-if="localDomName" class="muted">dom: {{ localDomName }}</div>

      <label class="muted">A11y JSON</label>
      <input type="file" accept="application/json" @change="onLocalA11yFileChange" />
      <div v-if="localA11yName" class="muted">a11y: {{ localA11yName }}</div>

      <button :disabled="loading || !localDomTree || !localA11yTree" @click="buildSnapshotFromLocal">
        {{ loading ? '构建中...' : '用本地树构建 Snapshot' }}
      </button>
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
      <h2>Node Detail</h2>
    </div>

    <div v-if="selectedNode" class="section">
      <div class="kv"><span class="k">id</span><span>{{ selectedNode.id }}</span></div>
      <div class="kv"><span class="k">role</span><span>{{ selectedNode.role || '-' }}</span></div>
      <div class="kv"><span class="k">name</span><span>{{ selectedNode.name || '-' }}</span></div>
      <div class="kv"><span class="k">content</span><span>{{ selectedNode.content || selectedNode.text || '-' }}</span></div>
      <div class="kv"><span class="k">target</span></div>
      <pre>{{ selectedTarget }}</pre>
      <div class="kv"><span class="k">bbox</span></div>
      <pre>{{ selectedBbox }}</pre>
      <div class="kv"><span class="k">attrs</span></div>
      <pre>{{ selectedAttrs }}</pre>
    </div>

    <div v-else class="section">
      <div class="muted">click one node in tree</div>
    </div>

    <div class="section">
      <h2>Detected Entities</h2>
      <div v-if="detectedEntities.length === 0" class="muted">no entity recognized</div>
      <div v-else class="entity-list">
        <button
          v-for="entity in detectedEntities"
          :key="`${entity.entityId}-${entity.nodeId}`"
          class="entity-item"
          @click="selectEntity(entity)"
        >
          <div class="entity-top">
            <span class="badge">{{ entity.entityType }}</span>
            <span class="entity-id">{{ entity.entityId }}</span>
          </div>
          <div class="entity-label">{{ entity.label }}</div>
          <div class="entity-metrics">fields={{ entity.fieldCount }} actions={{ entity.actionCount }}</div>
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
    <button class="context-item" @click="copyCurrentTree">复制整棵树 JSON</button>
    <button class="context-item" @click="copyCurrentNode">复制当前节点 JSON</button>
    <button class="context-item" @click="copyCurrentNodePath">复制节点路径</button>
    <button class="context-item" @click="copyCurrentNodeNameOrContent">复制 name/content</button>
    <button class="context-item" :disabled="!(contextMenu.node?.target?.ref || selectedNode?.target?.ref)" @click="copyCurrentTargetRef">
      复制 target.ref
    </button>
  </div>

  <div v-if="copyMessage" class="copy-toast">{{ copyMessage }}</div>
</template>
