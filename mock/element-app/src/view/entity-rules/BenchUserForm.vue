<template>
  <el-space direction="vertical" style="width: 100%">
    <TaskBanner :title="caseData.title" :description="caseData.description" />
    <el-card header="用户维护表单">
      <BusinessForm
        mode="form"
        :values="formValues"
        @change="onFormChange"
        @submit="onSubmit"
        @save-draft="onSaveDraft"
        @reset="onReset"
        @cancel="onCancel"
      />
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
import DebugPanel from '../../component/entity-rules/DebugPanel.vue';
import ScorePanel from '../../component/entity-rules/ScorePanel.vue';
import TaskBanner from '../../component/entity-rules/TaskBanner.vue';
import { getUserFormCase } from '../../service/entity-rules/case-service';
import { scoreUserFormCase } from '../../service/entity-rules/score-service';
import { setLastScore } from '../../store/entity-rules';

const route = useRoute();
const caseData = computed(() => getUserFormCase(String(route.params.caseId || '')));
const formValues = reactive({ userNo: '', userName: '', phone: '', role: '管理员' });
const submitted = ref(false);

watch(
  caseData,
  (next) => {
    formValues.userNo = next.initialData.userNo;
    formValues.userName = next.initialData.userName;
    formValues.phone = next.initialData.phone;
    formValues.role = next.initialData.role;
    submitted.value = false;
  },
  { immediate: true },
);

const score = computed(() => {
  const output = scoreUserFormCase(caseData.value, {
    userNo: formValues.userNo,
    userName: formValues.userName,
    phone: formValues.phone,
    role: formValues.role,
    submitted: submitted.value,
  });
  setLastScore(output);
  return output;
});

const onFormChange = (next: Record<string, string>) => {
  formValues.userNo = next.userNo || '';
  formValues.userName = next.userName || '';
  formValues.phone = next.phone || '';
  formValues.role = next.role || '管理员';
};

const onSubmit = () => {
  submitted.value = true;
  ElMessage.success('表单已提交');
};

const onSaveDraft = () => {
  ElMessage.info('草稿已保存');
};

const onReset = () => {
  formValues.userNo = caseData.value.initialData.userNo;
  formValues.userName = caseData.value.initialData.userName;
  formValues.phone = caseData.value.initialData.phone;
  formValues.role = caseData.value.initialData.role;
  submitted.value = false;
  ElMessage.info('已重置表单');
};

const onCancel = () => {
  onReset();
  ElMessage.warning('已取消编辑');
};
</script>
