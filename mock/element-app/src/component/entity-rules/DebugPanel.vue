<template>
  <el-card header="结构化结果">
    <pre style="margin: 0; max-height: 220px; overflow: auto">{{ JSON.stringify(data, null, 2) }}</pre>
  </el-card>
</template>

<script setup lang="ts">
defineProps<{ data: unknown }>();
</script>
