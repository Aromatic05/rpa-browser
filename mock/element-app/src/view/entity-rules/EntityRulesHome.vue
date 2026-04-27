<template>
  <el-space direction="vertical" style="width: 100%">
    <h2>Element Entity Rules Workspace</h2>
    <el-card header="Fixtures">
      <el-space direction="vertical" alignment="start">
        <router-link to="/entity-rules/fixtures/user-list">Fixture User List</router-link>
        <router-link to="/entity-rules/fixtures/user-form">Fixture User Form</router-link>
      </el-space>
    </el-card>
    <el-card header="Benchmarks">
      <el-space direction="vertical" alignment="start">
        <router-link v-for="item in listCases" :key="item.id" :to="`/entity-rules/bench/user-list/${item.id}`">
          Bench User List - {{ item.title }}
        </router-link>
        <router-link v-for="item in formCases" :key="item.id" :to="`/entity-rules/bench/user-form/${item.id}`">
          Bench User Form - {{ item.title }}
        </router-link>
      </el-space>
    </el-card>
  </el-space>
</template>

<script setup lang="ts">
import { getUserFormCaseOptions, getUserListCaseOptions } from '../../service/entity-rules/case-service';

const listCases = getUserListCaseOptions();
const formCases = getUserFormCaseOptions();
</script>
