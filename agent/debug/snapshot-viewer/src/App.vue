<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import TreeNode from './components/TreeNode.vue';
import type { DataPack, SourceKind, TreeNodeLike } from './types';

const source = ref<SourceKind>('unifiedGraph');
const error = ref('');
const jsonInput = ref('');
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

const loadSample = async () => {
  error.value = '';
  try {
    const url = `${import.meta.env.BASE_URL}sample-data.json`;
    const response = await fetch(url);
    const sample = await response.json();

    dataPack.value = {
      domTree: (sample as Record<string, unknown>).domTree || null,
      a11yTree: (sample as Record<string, unknown>).a11yTree || null,
      unifiedGraph: (sample as Record<string, unknown>).unifiedGraph || null,
    };
    selectedNode.value = null;
  } catch (cause) {
    error.value = `load sample failed: ${String(cause)}`;
  }
};

const onSelect = (node: TreeNodeLike) => {
  selectedNode.value = node;
};

const onFileChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    jsonInput.value = String(reader.result || '');
  };
  reader.readAsText(file);
};

const applyJson = () => {
  error.value = '';
  try {
    const parsed = JSON.parse(jsonInput.value || '{}') as Record<string, unknown>;
    dataPack.value = {
      domTree: parsed.domTree || null,
      a11yTree: parsed.a11yTree || null,
      unifiedGraph: parsed.unifiedGraph || (parsed.root ? { root: parsed.root } : null),
    };
    selectedNode.value = null;
  } catch (cause) {
    error.value = `invalid json: ${String(cause)}`;
  }
};

onMounted(() => {
  void loadSample();
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
      <h2>Load JSON</h2>
      <input type="file" accept="application/json" @change="onFileChange" />
      <textarea v-model="jsonInput" rows="9" placeholder="paste json here" />
      <button @click="applyJson">Apply JSON</button>
      <button class="secondary" @click="loadSample">Load Sample</button>
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
