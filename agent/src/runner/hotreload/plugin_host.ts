import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';
import type { RunnerPlugin, CreateTraceToolsFn } from '../plugin_entry';
import type { ExecutorFn } from '../steps/executors';

const log = getLogger('action');

export class RunnerPluginHost {
    private entryFile: string;
    private plugin: RunnerPlugin | null = null;
    private listeners = new Set<(plugin: RunnerPlugin) => void>();
    private hotBundleDir: string | null = null;

    constructor(entryFile: string) {
        this.entryFile = entryFile;
    }

    private async resolveImportSpecifier(): Promise<string> {
        if (!this.entryFile.endsWith('.ts') && !this.entryFile.endsWith('.tsx')) {
            const url = pathToFileURL(this.entryFile);
            url.searchParams.set('v', Date.now().toString());
            return url.toString();
        }

        const { build } = await import('esbuild');
        const outDir = this.hotBundleDir ?? path.resolve(process.cwd(), '.runner-hot');
        this.hotBundleDir = outDir;
        await fs.mkdir(outDir, { recursive: true });
        const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const outfile = path.join(outDir, `plugin.${stamp}.mjs`);
        await build({
            entryPoints: [this.entryFile],
            outfile,
            bundle: true,
            format: 'esm',
            platform: 'node',
            packages: 'external',
            sourcemap: false,
            logLevel: 'silent',
        });
        void this.pruneHotBundles(outDir, 8);
        return pathToFileURL(outfile).toString();
    }

    private async pruneHotBundles(outDir: string, keepCount: number): Promise<void> {
        try {
            const files = await fs.readdir(outDir);
            const candidates = files.filter((file) => file.startsWith('plugin.') && file.endsWith('.mjs')).sort();
            if (candidates.length <= keepCount) {return;}
            const stale = candidates.slice(0, candidates.length - keepCount);
            await Promise.all(stale.map((file) => fs.rm(path.join(outDir, file), { force: true })));
        } catch {
            // Best effort cleanup only.
        }
    }

    private async importPlugin(): Promise<RunnerPlugin> {
        const specifier = await this.resolveImportSpecifier();
        const mod = await import(specifier);
        const factory = (mod.default ?? mod.createRunnerPlugin) as (() => RunnerPlugin) | undefined;
        if (!factory) {
            throw new Error('Runner plugin entry missing createRunnerPlugin export');
        }
        const plugin = await factory();
        if (!plugin || typeof plugin !== 'object' || !plugin.executors) {
            throw new Error('Runner plugin is invalid');
        }
        return plugin;
    }

    async load(): Promise<RunnerPlugin> {
        const plugin = await this.importPlugin();
        this.plugin = plugin;
        this.emitReload(plugin);
        return plugin;
    }

    async reload(): Promise<RunnerPlugin | null> {
        try {
            const plugin = await this.importPlugin();
            this.plugin = plugin;
            // Use warning level so it is visible under default actionLogLevel=warning.
            log.warning('[runner] hot reload OK');
            this.emitReload(plugin);
            return plugin;
        } catch (error) {
            log.warning('[runner] hot reload FAILED (kept previous)', error instanceof Error ? error.message : error);
            return this.plugin;
        }
    }

    getExecutors(): Record<string, ExecutorFn> {
        return this.plugin?.executors ?? {};
    }

    getTraceToolsFactory(): CreateTraceToolsFn | null {
        return this.plugin?.createTraceTools ?? null;
    }

    onReload(handler: (plugin: RunnerPlugin) => void): () => void {
        this.listeners.add(handler);
        if (this.plugin) {
            handler(this.plugin);
        }
        return () => {
            this.listeners.delete(handler);
        };
    }

    private emitReload(plugin: RunnerPlugin) {
        for (const handler of this.listeners) {
            handler(plugin);
        }
    }

    watchDev(watchTarget: string): () => Promise<void> {
        const watcher = chokidar.watch(watchTarget, { ignoreInitial: true });
        let timer: NodeJS.Timeout | null = null;

        const schedule = () => {
            if (timer) {clearTimeout(timer);}
            timer = setTimeout(() => {
                void this.reload();
            }, 80);
        };

        watcher.on('add', schedule);
        watcher.on('change', schedule);
        watcher.on('unlink', schedule);

        return async () => {
            if (timer) {clearTimeout(timer);}
            await watcher.close();
        };
    }
}
