<script setup lang="ts">
import {computed, onMounted, ref} from 'vue';
import TreeNode from './components/TreeNode.vue';
import type {
  CaptureItemApiResponse,
  CaptureListApiResponse,
  CaptureListItem,
  ProjectionNode,
  SnapshotApiResponse,
  SnapshotProjection,
} from './types';

type ViewName = 'tree' | 'components' | 'semantics' | 'diagnostics' | 'json';
const targetUrl = ref('https://example.com');
const projectionMode = ref<'overview' | 'interaction' | 'annotation' | 'debug' | 'full'>('debug');
const views: ViewName[] = ['tree', 'components', 'semantics', 'diagnostics', 'json'];
const activeView = ref<ViewName>('tree');
const loading = ref(false);
const error = ref('');
const projection = ref<SnapshotProjection | null>(null);
const selectedNode = ref<ProjectionNode | null>(null);
const captures = ref<CaptureListItem[]>([]);
const captureStoreDir = ref('');

const summary = computed(() => {
  const value = projection.value;
  return value ? [
    ['节点', value.meta.includedNodeCount],
    ['表单', value.components.forms.length],
    ['表格', value.components.tables.length],
    ['语义绑定', value.semantics.length],
    ['诊断', value.diagnostics.length],
  ] : [];
});

const isProjection = (value: unknown): value is SnapshotProjection => Boolean(
  value && typeof value === 'object'
  && (value as {schemaVersion?: unknown}).schemaVersion === 2
  && Array.isArray((value as {roots?: unknown}).roots),
);

const setProjection = (value: SnapshotProjection): void => {
  projection.value = value;
  selectedNode.value = value.roots[0] ?? null;
  error.value = '';
};

const capturePage = async (): Promise<void> => {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch('/api/snapshot', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: targetUrl.value, mode: projectionMode.value}),
    });
    const payload = await response.json() as SnapshotApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setProjection(payload.data.projection);
    targetUrl.value = payload.data.url;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
};

const refreshCaptures = async (): Promise<void> => {
  try {
    const response = await fetch('/api/capture/list');
    const payload = await response.json() as CaptureListApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {throw new Error(payload.error || 'capture list failed');}
    captures.value = payload.data.items;
    captureStoreDir.value = payload.data.storeDir;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
};

const loadCapture = async (id: string): Promise<void> => {
  loading.value = true;
  try {
    const response = await fetch(`/api/capture/item?id=${encodeURIComponent(id)}`);
    const payload = await response.json() as CaptureItemApiResponse;
    if (!response.ok || !payload.ok || !payload.data) {throw new Error(payload.error || 'capture load failed');}
    if (!isProjection(payload.data.snapshot)) {
      throw new Error('该采集不是 Snapshot V2 Projection；旧 V1 snapshot 不再由 viewer 兼容。');
    }
    setProjection(payload.data.snapshot);
    targetUrl.value = payload.data.finalUrl || payload.data.sourceUrl || payload.data.snapshot.meta.pageUrl;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
};

const selectNode = (node: ProjectionNode): void => {
  selectedNode.value = node;
};

onMounted(refreshCaptures);
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">RPA Browser Debug Tooling</p>
        <h1>Snapshot V2 Viewer</h1>
      </div>
      <div class="capture-form">
        <input v-model="targetUrl" aria-label="Target URL" @keyup.enter="capturePage">
        <select v-model="projectionMode" aria-label="Projection mode">
          <option value="overview">overview</option>
          <option value="interaction">interaction</option>
          <option value="annotation">annotation</option>
          <option value="debug">debug</option>
          <option value="full">full</option>
        </select>
        <button type="button" :disabled="loading" @click="capturePage">
          {{ loading ? '采集中…' : '抓取 V2 Projection' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <section v-if="projection" class="summary-grid">
      <article v-for="[label, value] in summary" :key="String(label)" class="summary-card">
        <span>{{ label }}</span><strong>{{ value }}</strong>
      </article>
      <article class="summary-card meta-card">
        <span>{{ projection.meta.viewMode }} / {{ projection.meta.refreshReason }}</span>
        <strong>{{ projection.meta.pageEpoch }}:{{ projection.meta.captureRevision }}</strong>
      </article>
    </section>

    <nav class="view-tabs" aria-label="Viewer sections">
      <button v-for="view in views" :key="view"
        type="button" :class="{active: activeView === view}" @click="activeView = view">
        {{ view }}
      </button>
    </nav>

    <section v-if="projection" class="workspace">
      <div v-if="activeView === 'tree'" class="tree-layout">
        <div class="panel tree-panel">
          <TreeNode v-for="root in projection.roots" :key="root.nodeId" :node="root"
            :selected-node-id="selectedNode?.nodeId" @select="selectNode" />
        </div>
        <div class="panel detail-panel">
          <h2>Node detail</h2>
          <pre>{{ JSON.stringify(selectedNode, null, 2) }}</pre>
        </div>
      </div>

      <div v-else-if="activeView === 'components'" class="card-list">
        <article v-for="form in projection.components.forms" :key="form.id" class="data-card">
          <h2>Form · {{ form.id }}</h2>
          <p>{{ form.status }} · fields {{ form.fields.length }} · actions {{ form.actions.length }}</p>
          <pre>{{ JSON.stringify(form, null, 2) }}</pre>
        </article>
        <article v-for="table in projection.components.tables" :key="table.id" class="data-card">
          <h2>Table · {{ table.id }}</h2>
          <p>{{ table.status }} · columns {{ table.columns.length }} · rows {{ table.rows.length }}</p>
          <pre>{{ JSON.stringify(table, null, 2) }}</pre>
        </article>
      </div>

      <div v-else-if="activeView === 'semantics'" class="card-list">
        <article v-for="binding in projection.semantics" :key="binding.id" class="data-card">
          <h2>{{ binding.profileName }} / {{ binding.id }}</h2>
          <p>{{ binding.domain }} · {{ binding.origin }} · {{ binding.status }}</p>
          <pre>{{ JSON.stringify(binding, null, 2) }}</pre>
        </article>
        <p v-if="projection.semantics.length === 0" class="empty">没有 SemanticBindings。</p>
      </div>

      <div v-else-if="activeView === 'diagnostics'" class="card-list">
        <article v-for="diagnostic in projection.diagnostics" :key="`${diagnostic.code}:${diagnostic.message}`" class="data-card">
          <h2>{{ diagnostic.code }}</h2>
          <p>{{ diagnostic.severity }} · {{ diagnostic.stage }} · {{ diagnostic.status }}</p>
          <pre>{{ JSON.stringify(diagnostic, null, 2) }}</pre>
        </article>
        <p v-if="projection.diagnostics.length === 0" class="empty">没有诊断。</p>
      </div>

      <pre v-else class="panel json-panel">{{ JSON.stringify(projection, null, 2) }}</pre>
    </section>

    <aside class="captures-panel">
      <div class="captures-heading">
        <div><h2>Stored captures</h2><small>{{ captureStoreDir }}</small></div>
        <button type="button" @click="refreshCaptures">刷新</button>
      </div>
      <div class="capture-list">
        <button v-for="item in captures" :key="item.id" type="button" class="capture-item" @click="loadCapture(item.id)">
          <strong>{{ item.label }}</strong>
          <span>{{ item.capturedAt }}</span>
          <small>{{ item.finalUrl || item.sourceUrl || 'no URL' }}</small>
        </button>
        <p v-if="captures.length === 0" class="empty">没有已存储采集。</p>
      </div>
    </aside>
  </main>
</template>
