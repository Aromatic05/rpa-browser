<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type { DataPack, SnapshotApiResponse, SourceKind, TreeNodeLike } from './types';

const source = ref<SourceKind>('unifiedGraph');
const error = ref('');
const loading = ref(false);
const targetUrl = ref('https://example.com');
const resolvedUrl = ref('');
const selectedNode = ref<TreeNodeLike | null>(null);
const copyMessage = ref('');
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

const selectedAttrs = computed(() => JSON.stringify(selectedNode.value?.attrs || {}, null, 2));
const selectedTarget = computed(() => JSON.stringify(selectedNode.value?.target || {}, null, 2));
const selectedBbox = computed(() => JSON.stringify(selectedNode.value?.bbox || {}, null, 2));

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
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    const payload = (await response.json()) as SnapshotApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error || `request failed (${response.status})`);
    }

    dataPack.value = {
      domTree: payload.data.domTree || null,
      a11yTree: payload.data.a11yTree || null,
      unifiedGraph: payload.data.unifiedGraph || null,
    };
    resolvedUrl.value = payload.data.url || url;
    selectedNode.value = null;
  } catch (cause) {
    error.value = `抓取失败: ${String(cause)}`;
  } finally {
    loading.value = false;
  }
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
  const walk = (node: TreeNodeLike): boolean => {
    path.push(node.id);
    if (node.id === targetId) return true;
    for (const child of node.children) {
      if (walk(child)) return true;
    }
    path.pop();
    return false;
  };
  return walk(root) ? path : [];
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
  const ref = node?.target?.ref;
  if (!ref) return;
  await copyText(ref, '已复制 target.ref');
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
      <div v-if="resolvedUrl" class="muted">当前页面：{{ resolvedUrl }}</div>
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
