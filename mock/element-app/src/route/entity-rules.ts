import type { RouteRecordRaw } from 'vue-router';
import BenchUserForm from '../view/entity-rules/BenchUserForm.vue';
import BenchUserList from '../view/entity-rules/BenchUserList.vue';
import EntityRulesHome from '../view/entity-rules/EntityRulesHome.vue';
import FixtureUserForm from '../view/entity-rules/FixtureUserForm.vue';
import FixtureUserList from '../view/entity-rules/FixtureUserList.vue';

export const entityRulesRoutes: RouteRecordRaw[] = [
    { path: '/entity-rules', component: EntityRulesHome },
    { path: '/entity-rules/fixtures/user-list', component: FixtureUserList },
    { path: '/entity-rules/fixtures/user-form', component: FixtureUserForm },
    { path: '/entity-rules/bench/user-list/:caseId', component: BenchUserList },
    { path: '/entity-rules/bench/user-form/:caseId', component: BenchUserForm },
    { path: '/:pathMatch(.*)*', redirect: '/entity-rules' },
];
