import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';
import type { McpToolDeps } from '../tool_handlers';
import type { McpToolRuntime } from '../server';

type CreateMcpToolRuntimeFn = (deps: McpToolDeps) => McpToolRuntime | Promise<McpToolRuntime>;

const log = getLogger('action');

export class McpToolHost {
    private entryFile: string;
    private runtime: McpToolRuntime | null = null;
    private hotBundleDir: string | null = null;

    constructor(entryFile: string) {
        this.entryFile = entryFile;
    }

    getRuntime(): McpToolRuntime | null {
        return this.runtime;
    }

    async load(deps: McpToolDeps): Promise<McpToolRuntime> {
        const next = await this.importRuntime(deps);
        this.runtime = next;
        return next;
    }

    async reload(deps: McpToolDeps): Promise<McpToolRuntime | null> {
        try {
            const next = await this.importRuntime(deps);
            this.runtime = next;
            log.warning('[mcp] hot reload OK');
            return next;
        } catch (error) {
            log.warning('[mcp] hot reload FAILED (kept previous)', error instanceof Error ? error.message : error);
            return this.runtime;
        }
    }

    watchDev(watchTarget: string, deps: McpToolDeps): () => Promise<void> {
        const watcher = chokidar.watch(watchTarget, { ignoreInitial: true });
        let timer: NodeJS.Timeout | null = null;

        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                void this.reload(deps);
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

    private async importRuntime(deps: McpToolDeps): Promise<McpToolRuntime> {
        const specifier = await this.resolveImportSpecifier();
        const mod = await import(specifier);
        const factory = (mod.default ?? mod.createMcpToolRuntime) as CreateMcpToolRuntimeFn | undefined;
        if (!factory) {
            throw new Error('MCP hot entry missing createMcpToolRuntime export');
        }
        const runtime = await factory(deps);
        if (!runtime || typeof runtime !== 'object' || !runtime.handlers || !runtime.tools) {
            throw new Error('MCP tool runtime is invalid');
        }
        return runtime;
    }

    private async resolveImportSpecifier(): Promise<string> {
        if (!this.entryFile.endsWith('.ts') && !this.entryFile.endsWith('.tsx')) {
            const url = pathToFileURL(this.entryFile);
            url.searchParams.set('v', Date.now().toString());
            return url.toString();
        }

        const { build } = await import('esbuild');
        const outDir = this.hotBundleDir ?? path.resolve(process.cwd(), '.mcp-hot');
        this.hotBundleDir = outDir;
        await fs.mkdir(outDir, { recursive: true });
        const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const outfile = path.join(outDir, `mcp.${stamp}.mjs`);
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
            const candidates = files.filter((file) => file.startsWith('mcp.') && file.endsWith('.mjs')).sort();
            if (candidates.length <= keepCount) return;
            const stale = candidates.slice(0, candidates.length - keepCount);
            await Promise.all(stale.map((file) => fs.rm(path.join(outDir, file), { force: true })));
        } catch {
            // Best effort cleanup only.
        }
    }
}
