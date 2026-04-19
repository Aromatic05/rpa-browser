import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSnapshotApiPlugin } from './server/snapshotApi';

export default defineConfig({
  plugins: [vue(), createSnapshotApiPlugin()],
});
