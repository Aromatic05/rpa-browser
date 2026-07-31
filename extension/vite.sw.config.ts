import {resolve} from 'node:path';
import {defineConfig} from 'vite';

export default defineConfig({
    build: {
        target: 'es2022',
        lib: {
            entry: resolve(__dirname, 'src/entry/sw.ts'),
            formats: ['es'],
            fileName: () => 'sw.js',
        },
        rollupOptions: {
            output: {
                entryFileNames: 'sw.js',
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist/entry',
        emptyOutDir: false,
    },
});
