<template>
  <el-card v-if="result" :header="`评分结果 ${result.score}/${result.maxScore}`">
    <el-progress :percentage="Math.round((result.score / result.maxScore) * 100)" />
    <el-table :data="result.items" size="small" style="margin-top: 12px">
      <el-table-column prop="key" label="Key" />
      <el-table-column prop="score" label="Score" />
      <el-table-column label="OK">
        <template #default="scope">
          <el-tag :type="scope.row.ok ? 'success' : 'danger'">{{ scope.row.ok ? 'YES' : 'NO' }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import type { ScoreResult } from '../../types/entity-rules';

defineProps<{ result?: ScoreResult }>();
</script>
