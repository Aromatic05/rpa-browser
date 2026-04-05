<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TreeNodeLike } from '../types';

defineOptions({ name: 'TreeNode' });

const props = withDefaults(
  defineProps<{
    node: TreeNodeLike;
    depth?: number;
    selectedId?: string;
  }>(),
  {
    depth: 0,
    selectedId: '',
  },
);

const emit = defineEmits<{
  (e: 'select', value: TreeNodeLike): void;
  (e: 'contextmenu-node', value: { node: TreeNodeLike; x: number; y: number }): void;
}>();

const open = ref(props.depth < 2);

const hasChildren = computed(() => props.node.children.length > 0);
const isSelected = computed(() => props.selectedId === props.node.id);
const roleLabel = computed(() => props.node.role || 'node');
const nodeLabel = computed(() => props.node.name || props.node.contentRef || '');

const toggle = (event: MouseEvent) => {
  event.stopPropagation();
  if (!hasChildren.value) return;
  open.value = !open.value;
};

const selectNode = () => {
  emit('select', props.node);
};

const openContextMenu = (event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  emit('select', props.node);
  emit('contextmenu-node', {
    node: props.node,
    x: event.clientX,
    y: event.clientY,
  });
};
</script>

<template>
  <div class="tree-node">
    <div class="tree-line" :class="{ selected: isSelected }" @click="selectNode" @contextmenu="openContextMenu">
      <span class="badge" @click="toggle">{{ hasChildren ? (open ? '-' : '+') : '·' }}</span>
      <span>{{ roleLabel }}</span>
      <span v-if="nodeLabel" class="muted">[{{ nodeLabel }}]</span>
    </div>

    <div v-if="hasChildren && open" class="tree-children">
      <TreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="emit('select', $event)"
        @contextmenu-node="emit('contextmenu-node', $event)"
      />
    </div>
  </div>
</template>
