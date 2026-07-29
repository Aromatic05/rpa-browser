<script setup lang="ts">
import {computed, ref} from 'vue';
import type {ProjectionNode} from '../types';

defineOptions({name: 'TreeNode'});
const props = withDefaults(defineProps<{
  node: ProjectionNode;
  depth?: number;
  selectedNodeId?: string;
}>(), {depth: 0, selectedNodeId: ''});
const emit = defineEmits<{(event: 'select', node: ProjectionNode): void}>();
const expanded = ref(props.depth < 2);
const hasChildren = computed(() => props.node.children.length > 0);
const label = computed(() => props.node.name || props.node.text || props.node.contentRef || '');
</script>

<template>
  <div class="tree-node">
    <button
      class="tree-row"
      :class="{selected: selectedNodeId === node.nodeId}"
      type="button"
      @click="emit('select', node)"
    >
      <span class="tree-toggle" @click.stop="expanded = !expanded">
        {{ hasChildren ? (expanded ? '−' : '+') : '·' }}
      </span>
      <code>{{ node.role || node.tag }}</code>
      <span v-if="label" class="tree-label">{{ label }}</span>
      <span class="tree-id">{{ node.nodeId }}</span>
    </button>
    <div v-if="expanded && hasChildren" class="tree-children">
      <TreeNode
        v-for="child in node.children"
        :key="child.nodeId"
        :node="child"
        :depth="depth + 1"
        :selected-node-id="selectedNodeId"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>
