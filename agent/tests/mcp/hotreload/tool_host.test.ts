import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpToolHost } from '../../../src/mcp/hotreload/tool_host';

const ENTRY_SOURCE = `
import { value } from './dep.ts';

export const createMcpToolRuntime = () => ({
  handlers: {
    'browser.__test': async () => ({
      ok: true,
      results: [{ stepId: 'step', ok: true, data: { value } }],
    }),
  },
  tools: [
    {
      name: 'browser.__test',
      description: 'value=' + value,
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
`;

const writeDep = async (dir: string, value: string) => {
    await writeFile(path.join(dir, 'dep.ts'), `export const value = '${value}';\n`, 'utf8');
};

test('McpToolHost reload refreshes transitive TS module changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-tool-host-'));
    try {
        const entry = path.join(dir, 'entry.ts');
        await writeDep(dir, 'A');
        await writeFile(entry, ENTRY_SOURCE, 'utf8');

        const host = new McpToolHost(entry);
        await host.load({ pageRegistry: {} as never });

        const first = host.getRuntime();
        assert.ok(first, 'runtime should be available after load');
        assert.equal(first?.tools[0]?.description, 'value=A');
        const firstResult = await first?.handlers['browser.__test']({});
        assert.equal((firstResult?.results?.[0] as any)?.data?.value, 'A');

        await writeDep(dir, 'B');
        const reloaded = await host.reload({ pageRegistry: {} as never });
        assert.ok(reloaded, 'reload should keep or replace runtime');

        const second = host.getRuntime();
        assert.equal(second?.tools[0]?.description, 'value=B');
        const secondResult = await second?.handlers['browser.__test']({});
        assert.equal((secondResult?.results?.[0] as any)?.data?.value, 'B');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
