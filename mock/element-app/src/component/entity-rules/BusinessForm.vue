<template>
  <el-form v-if="mode === 'list'" :model="listValues" label-position="top" role="form" aria-label="用户筛选表单">
    <el-row :gutter="16">
      <el-col :span="8">
        <el-form-item label="用户编号">
          <el-input v-model="listValues.userNo" placeholder="请输入用户编号" @input="emitListChange" />
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="用户名">
          <el-input v-model="listValues.userName" placeholder="请输入用户名" @input="emitListChange" />
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="状态">
          <el-select v-model="listValues.status" @change="emitListChange">
            <el-option label="全部" value="全部" />
            <el-option label="启用" value="启用" />
            <el-option label="停用" value="停用" />
          </el-select>
        </el-form-item>
      </el-col>
    </el-row>
    <el-space>
      <el-button type="primary" @click="$emit('submit')">查询</el-button>
      <el-button @click="$emit('reset')">重置</el-button>
    </el-space>
  </el-form>

  <el-form v-else :model="formValues" label-position="top" role="form" aria-label="用户信息表单">
    <el-row :gutter="16">
      <el-col :span="12">
        <el-form-item label="用户编号" required>
          <el-input v-model="formValues.userNo" placeholder="例如 USR-101" @input="emitFormChange" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="用户名" required>
          <el-input v-model="formValues.userName" placeholder="请输入用户名" @input="emitFormChange" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="手机号" required>
          <el-input v-model="formValues.phone" placeholder="请输入手机号" @input="emitFormChange" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="角色" required>
          <el-select v-model="formValues.role" @change="emitFormChange">
            <el-option label="管理员" value="管理员" />
            <el-option label="业务员" value="业务员" />
            <el-option label="访客" value="访客" />
          </el-select>
        </el-form-item>
      </el-col>
    </el-row>
    <el-space>
      <el-button type="primary" @click="$emit('submit')">提交</el-button>
      <el-button @click="$emit('save-draft')">保存草稿</el-button>
      <el-button @click="$emit('reset')">重置</el-button>
      <el-button @click="$emit('cancel')">取消</el-button>
    </el-space>
  </el-form>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';

const props = defineProps<{
  mode: 'list' | 'form';
  values: Record<string, string>;
}>();

const emit = defineEmits<{
  change: [Record<string, string>];
  submit: [];
  reset: [];
  'save-draft': [];
  cancel: [];
}>();

const listValues = reactive({ userNo: '', userName: '', status: '全部' });
const formValues = reactive({ userNo: '', userName: '', phone: '', role: '管理员' });

watch(
  () => props.values,
  (next) => {
    if (props.mode === 'list') {
      listValues.userNo = next.userNo || '';
      listValues.userName = next.userName || '';
      listValues.status = next.status || '全部';
      return;
    }
    formValues.userNo = next.userNo || '';
    formValues.userName = next.userName || '';
    formValues.phone = next.phone || '';
    formValues.role = next.role || '管理员';
  },
  { immediate: true },
);

const emitListChange = () => emit('change', { ...listValues });
const emitFormChange = () => emit('change', { ...formValues });
</script>
