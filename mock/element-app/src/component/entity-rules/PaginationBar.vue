<template>
  <div style="display: flex; justify-content: flex-end">
    <el-pagination layout="prev, pager, next" :current-page="page" :page-size="pageSize" :total="total" />
  </div>
</template>

<script setup lang="ts">
defineProps<{ page: number; pageSize: number; total: number }>();
</script>
