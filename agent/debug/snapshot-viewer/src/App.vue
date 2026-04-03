<script setup lang="ts">
import { computed, ref } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type { DataPack, SnapshotApiResponse, SourceKind, TreeNodeLike } from './types';

const source = ref<SourceKind>('unifiedGraph');
const error = ref('');
const loading = ref(false);
const targetUrl = ref('https://example.com');
const resolvedUrl = ref('');
const selectedNode = ref<TreeNodeLike | null>(null);

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
    text: typeof maybeRecord.text === 'string' ? maybeRecord.text : undefined,
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

    <div class="tree-wrap">
      <TreeNode
        v-if="activeRoot"
        :node="activeRoot"
        :selected-id="selectedNode?.id || ''"
        @select="onSelect"
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
      <div class="kv"><span class="k">text</span><span>{{ selectedNode.text || '-' }}</span></div>
      <div class="kv"><span class="k">attrs</span></div>
      <pre>{{ selectedAttrs }}</pre>
    </div>

    <div v-else class="section">
      <div class="muted">click one node in tree</div>
    </div>
  </div>
</template>
