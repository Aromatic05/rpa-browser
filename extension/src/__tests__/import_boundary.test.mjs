import assert from 'node:assert/strict';
import fs from 'node:fs';
import { send } from '../../dist/shared/send.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.push(...walk(full));
            continue;
        }
        out.push(full);
    }
    return out;
};

const hasActionsImport = (text) =>
    text.includes('../actions')
    || text.includes('./actions')
    || text.includes('/actions/');

await log('shared files do not import actions', async () => {
    const files = walk(new URL('../shared', import.meta.url).pathname).filter((path) => path.endsWith('.ts'));
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        assert.equal(hasActionsImport(src), false, file);
    }
});

await log('content files do not import actions', async () => {
    const files = walk(new URL('../content', import.meta.url).pathname).filter((path) => path.endsWith('.ts'));
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        assert.equal(hasActionsImport(src), false, file);
    }
});

await log('shared send does not import actions catalog', async () => {
    const src = fs.readFileSync(new URL('../shared/send.ts', import.meta.url), 'utf8');
    assert.equal(src.includes('actions/action_types'), false);
    assert.equal(src.includes('../actions'), false);
});

await log('manifest web_accessible_resources does not include actions', async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources || []) || [];
    assert.equal(resources.includes('actions/*.js'), false);
});

await log('send.action returns action.type.failed on transport failure', async () => {
    const originalChrome = globalThis.chrome;
    const runtime = {
        lastError: null,
        sendMessage: (_req, cb) => {
            runtime.lastError = { message: 'Receiving end does not exist.' };
            cb(undefined);
            runtime.lastError = null;
        },
    };
    globalThis.chrome = {
        runtime,
        tabs: { sendMessage: () => undefined },
    };
    try {
        const reply = await send.action({ v: 1, id: 'req-1', type: 'workspace.list', payload: {} });
        assert.equal(reply.type, 'workspace.list.failed');
    } finally {
        globalThis.chrome = originalChrome;
    }
});

await log('send.action returns action.dispatch.failed when action.type is empty', async () => {
    const originalChrome = globalThis.chrome;
    const runtime = {
        lastError: null,
        sendMessage: (_req, cb) => {
            runtime.lastError = { message: 'Receiving end does not exist.' };
            cb(undefined);
            runtime.lastError = null;
        },
    };
    globalThis.chrome = {
        runtime,
        tabs: { sendMessage: () => undefined },
    };
    try {
        const reply = await send.action({ v: 1, id: 'req-2', type: '', payload: {} });
        assert.equal(reply.type, 'action.dispatch.failed');
    } finally {
        globalThis.chrome = originalChrome;
    }
});
