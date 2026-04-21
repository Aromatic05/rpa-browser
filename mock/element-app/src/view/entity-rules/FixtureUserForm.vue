<template>
  <el-space direction="vertical" style="width: 100%">
    <TaskBanner title="用户表单夹具页" description="用于 entity_rules 表单场景命中和 golden verify。" />
    <el-card header="用户信息维护">
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
  </el-space>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { ElMessage } from 'element-plus';
import BusinessForm from '../../component/entity-rules/BusinessForm.vue';
import TaskBanner from '../../component/entity-rules/TaskBanner.vue';
import { getUserFormFixture } from '../../service/entity-rules/fixture-service';

const initialValues = getUserFormFixture();
const formValues = reactive({ ...initialValues });

const onFormChange = (next: Record<string, string>) => {
  formValues.userNo = next.userNo || '';
  formValues.userName = next.userName || '';
  formValues.phone = next.phone || '';
  formValues.role = next.role || '管理员';
};

const onSubmit = () => {
  ElMessage.success(`已提交用户 ${formValues.userNo || '(未填写编号)'}`);
};

const onSaveDraft = () => {
  ElMessage.info('草稿已保存');
};

const onReset = () => {
  formValues.userNo = initialValues.userNo;
  formValues.userName = initialValues.userName;
  formValues.phone = initialValues.phone;
  formValues.role = initialValues.role;
  ElMessage.info('表单已重置');
};

const onCancel = () => {
  onReset();
  ElMessage.warning('已取消编辑');
};
</script>
