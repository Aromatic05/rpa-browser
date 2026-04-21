<template>
  <el-table :data="rows" style="width: 100%" role="table" aria-label="用户主表格">
    <el-table-column prop="userNo" label="用户编号" />
    <el-table-column prop="userName" label="用户名" />
    <el-table-column prop="phone" label="手机号" />
    <el-table-column prop="status" label="状态" />
    <el-table-column label="操作">
      <template #default="scope">
        <el-space>
          <el-button @click="emit('action', { action: 'view', row: scope.row })">详情</el-button>
          <el-button @click="emit('action', { action: 'edit', row: scope.row })">编辑</el-button>
          <el-button type="warning" @click="emit('action', { action: 'disable', row: scope.row })">禁用</el-button>
        </el-space>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import type { UserRecord } from '../../types/entity-rules';

defineProps<{ rows: UserRecord[] }>();
const emit = defineEmits<{
  action: [{ action: 'view' | 'edit' | 'disable'; row: UserRecord }];
}>();
</script>
