import { pathToFileURL } from 'node:url';
import chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';
import type { RunnerPlugin, CreateTraceToolsFn } from '../plugin_entry';
import type { ExecutorFn } from '../steps/executors';

const log = getLogger('step');

export class RunnerPluginHost {
    private entryFile: string;
    private plugin: RunnerPlugin | null = null;
    private listeners = new Set<(plugin: RunnerPlugin) => void>();

    constructor(entryFile: string) {
        this.entryFile = entryFile;
    }

    private async importPlugin(): Promise<RunnerPlugin> {
        const url = pathToFileURL(this.entryFile);
        url.searchParams.set('v', Date.now().toString());
        const mod = await import(url.toString());
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
            log('[runner] hot reload OK');
            this.emitReload(plugin);
            return plugin;
        } catch (error) {
            log('[runner] hot reload FAILED (kept previous)', error instanceof Error ? error.message : error);
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
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                void this.reload();
            }, 80);
        };

        watcher.on('add', schedule);
        watcher.on('change', schedule);
        watcher.on('unlink', schedule);

        return async () => {
            if (timer) clearTimeout(timer);
            await watcher.close();
        };
    }
}
