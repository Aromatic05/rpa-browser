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
}>();

const open = ref(props.depth < 2);

const hasChildren = computed(() => props.node.children.length > 0);
const isSelected = computed(() => props.selectedId === props.node.id);

const toggle = (event: MouseEvent) => {
  event.stopPropagation();
  if (!hasChildren.value) return;
  open.value = !open.value;
};

const selectNode = () => {
  emit('select', props.node);
};
</script>

<template>
  <div class="tree-node">
    <div class="tree-line" :class="{ selected: isSelected }" @click="selectNode">
      <span class="badge" @click="toggle">{{ hasChildren ? (open ? '-' : '+') : '·' }}</span>
      <span>{{ node.role || node.tag || 'node' }}</span>
      <span class="badge">{{ node.id }}</span>
      <span v-if="node.name">{{ node.name }}</span>
      <span v-else-if="node.text">{{ node.text }}</span>
    </div>

    <div v-if="hasChildren && open" class="tree-children">
      <TreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>
