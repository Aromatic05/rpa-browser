import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerPluginHost } from '../plugin_host';

const ENTRY_SOURCE = `
import { value } from './dep.ts';

export const createRunnerPlugin = () => ({
  executors: {
    __test_executor: async () => ({ stepId: 'step', ok: true, data: { value } }),
  },
  createTraceTools: () => ({ tools: {}, ctx: {} }),
});
`;

const writeDep = async (dir: string, value: string) => {
    await writeFile(path.join(dir, 'dep.ts'), `export const value = '${value}';\n`, 'utf8');
};

test('RunnerPluginHost reload refreshes transitive TS module changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-plugin-host-'));
    try {
        const entry = path.join(dir, 'entry.ts');
        await writeDep(dir, 'A');
        await writeFile(entry, ENTRY_SOURCE, 'utf8');

        const host = new RunnerPluginHost(entry);
        await host.load();
        const first = await host.getExecutors().__test_executor({} as never, {} as never, 'ws');
        assert.equal((first.data as { value: string }).value, 'A');

        await writeDep(dir, 'B');
        const reloaded = await host.reload();
        assert.ok(reloaded, 'reload should keep or replace plugin');
        const second = await host.getExecutors().__test_executor({} as never, {} as never, 'ws');
        assert.equal((second.data as { value: string }).value, 'B');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
