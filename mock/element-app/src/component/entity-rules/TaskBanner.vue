<template>
  <el-space direction="vertical" alignment="start" style="width: 100%">
    <h2 style="margin: 0">{{ title }}</h2>
    <el-alert :title="description" type="info" show-icon :closable="false" />
  </el-space>
</template>

<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>
