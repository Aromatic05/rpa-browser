import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
    build: {
        target: 'es2022',
        lib: {
            entry: resolve(__dirname, 'src/product/product_ui.ts'),
            formats: ['es'],
            fileName: () => 'product_ui.js',
        },
        rollupOptions: {
            output: {
                entryFileNames: 'product_ui.js',
                inlineDynamicImports: true,
            },
        },
        outDir: 'dist/product',
        emptyOutDir: false,
    },
});