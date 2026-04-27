import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { entityRulesRoutes } from './route/entity-rules';

const router = createRouter({
    history: createWebHistory(),
    routes: entityRulesRoutes,
});

createApp(App).use(router).use(ElementPlus).mount('#app');
