<template>
  <el-space direction="vertical" style="width: 100%">
    <TaskBanner title="用户列表夹具页" description="用于 entity_rules 列表场景命中和 golden verify。" />
    <el-card header="用户筛选">
      <BusinessForm mode="list" :values="filters" @change="onFormChange" @submit="onSubmit" @reset="onReset" />
    </el-card>
    <el-card header="用户列表" role="table" aria-label="用户主表格">
      <BusinessTable :rows="rows" @action="onRowAction" />
      <PaginationBar :page="fixture.pagination.page" :page-size="fixture.pagination.pageSize" :total="fixture.pagination.total" />
    </el-card>
  </el-space>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import BusinessForm from '../../component/entity-rules/BusinessForm.vue';
import BusinessTable from '../../component/entity-rules/BusinessTable.vue';
import PaginationBar from '../../component/entity-rules/PaginationBar.vue';
import TaskBanner from '../../component/entity-rules/TaskBanner.vue';
import { getUserListFixture } from '../../service/entity-rules/fixture-service';

const fixture = getUserListFixture();
const defaultFilters = { userNo: '', userName: '', status: '全部' };
const filters = reactive({ ...defaultFilters });
const appliedFilters = ref({ ...defaultFilters });

const rows = computed(() =>
  fixture.rows.filter((row) => {
    if (appliedFilters.value.userNo && !row.userNo.includes(appliedFilters.value.userNo)) return false;
    if (appliedFilters.value.userName && !row.userName.includes(appliedFilters.value.userName)) return false;
    if (appliedFilters.value.status !== '全部' && row.status !== appliedFilters.value.status) return false;
    return true;
  }),
);

const onFormChange = (next: Record<string, string>) => {
  filters.userNo = next.userNo || '';
  filters.userName = next.userName || '';
  filters.status = next.status || '全部';
};

const onSubmit = () => {
  const next = { userNo: filters.userNo, userName: filters.userName, status: filters.status };
  appliedFilters.value = next;
  const matched = fixture.rows.filter((row) => {
    if (next.userNo && !row.userNo.includes(next.userNo)) return false;
    if (next.userName && !row.userName.includes(next.userName)) return false;
    if (next.status !== '全部' && row.status !== next.status) return false;
    return true;
  });
  ElMessage.success(`查询完成，共 ${matched.length} 条`);
};

const onReset = () => {
  filters.userNo = '';
  filters.userName = '';
  filters.status = '全部';
  appliedFilters.value = { ...defaultFilters };
  ElMessage.info('已重置筛选条件');
};

const onRowAction = (payload: { action: 'view' | 'edit' | 'disable'; row: { userNo: string } }) => {
  if (payload.action === 'disable') {
    ElMessage.warning(`已禁用用户 ${payload.row.userNo}`);
    return;
  }
  ElMessage.info(`${payload.action === 'view' ? '查看' : '编辑'} ${payload.row.userNo}`);
};
</script>
