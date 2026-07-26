import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
    plugins: [vue()],
    build: {
        cssCodeSplit: false,
        lib: {
            entry: resolve(__dirname, 'src/annotator/main.ts'),
            formats: ['es'],
            fileName: () => 'annotator.js',
        },
        rollupOptions: {
            output: {
                entryFileNames: 'annotator.js',
                assetFileNames: 'annotator.css',
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist/annotator',
        emptyOutDir: false,
    },
});
