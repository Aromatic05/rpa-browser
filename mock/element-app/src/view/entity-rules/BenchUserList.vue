<template>
  <el-space direction="vertical" style="width: 100%">
    <TaskBanner :title="caseData.title" :description="caseData.description" />
    <el-card header="操作区域">
      <BusinessForm mode="list" :values="formValues" @change="onFormChange" @submit="onSubmit" @reset="onReset" />
    </el-card>
    <el-card header="用户列表" role="table" aria-label="用户主表格">
      <BusinessTable :rows="rows" @action="onRowAction" />
    </el-card>
    <ScorePanel :result="score" />
    <DebugPanel :data="score" />
  </el-space>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute } from 'vue-router';
import BusinessForm from '../../component/entity-rules/BusinessForm.vue';
import BusinessTable from '../../component/entity-rules/BusinessTable.vue';
import DebugPanel from '../../component/entity-rules/DebugPanel.vue';
import ScorePanel from '../../component/entity-rules/ScorePanel.vue';
import TaskBanner from '../../component/entity-rules/TaskBanner.vue';
import { getUserListCase } from '../../service/entity-rules/case-service';
import { scoreUserListCase } from '../../service/entity-rules/score-service';
import { setLastScore } from '../../store/entity-rules';

const route = useRoute();
const caseData = computed(() => getUserListCase(String(route.params.caseId || '')));
const formValues = reactive({ userNo: '', userName: '', status: '全部' });
const rows = ref(caseData.value.initialData.rows);
const submitted = ref(false);

watch(
  caseData,
  (next) => {
    formValues.userNo = next.initialData.filters.userNo;
    formValues.userName = next.initialData.filters.userName;
    formValues.status = next.initialData.filters.status;
    rows.value = next.initialData.rows;
    submitted.value = false;
  },
  { immediate: true },
);

const score = computed(() => {
  const output = scoreUserListCase(caseData.value, {
    userNo: formValues.userNo,
    userName: formValues.userName,
    status: formValues.status,
    submitted: submitted.value,
  });
  setLastScore(output);
  return output;
});

const onFormChange = (next: Record<string, string>) => {
  formValues.userNo = next.userNo || '';
  formValues.userName = next.userName || '';
  formValues.status = next.status || '全部';
};

const onSubmit = () => {
  submitted.value = true;
  ElMessage.success('已提交筛选条件');
};

const onReset = () => {
  formValues.userNo = caseData.value.initialData.filters.userNo;
  formValues.userName = caseData.value.initialData.filters.userName;
  formValues.status = caseData.value.initialData.filters.status;
  rows.value = caseData.value.initialData.rows;
  submitted.value = false;
  ElMessage.info('已重置筛选条件');
};

const onRowAction = (payload: { action: 'view' | 'edit' | 'disable'; row: { userNo: string } }) => {
  if (payload.action === 'disable') {
    rows.value = rows.value.filter((item) => item.userNo !== payload.row.userNo);
    ElMessage.warning(`已禁用 ${payload.row.userNo}`);
    return;
  }
  ElMessage.info(`${payload.action === 'view' ? '查看' : '编辑'} ${payload.row.userNo}`);
};
</script>
