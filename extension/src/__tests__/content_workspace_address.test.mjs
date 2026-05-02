import assert from 'node:assert/strict';
import fs from 'node:fs';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const floatingSrc = fs.readFileSync(new URL('../content/floating_ui.ts', import.meta.url), 'utf8');
const entrySrc = fs.readFileSync(new URL('../entry/content.ts', import.meta.url), 'utf8');

await log('tab.list uses scope workspaceName with empty payload', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('tab.list', {}, { workspaceName: activeWorkspaceName })"), true);
});

await log('tab.list payload does not include workspaceName', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('tab.list', { workspaceName: activeWorkspaceName })"), false);
});

await log('tab.setActive payload only includes tabName', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('tab.setActive', { tabName: tab.tabName }, { workspaceName: activeWorkspaceName })"), true);
});

await log('workspace.setActive payload is empty', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('workspace.setActive', {}, { workspaceName: ws.workspaceName })"), true);
    assert.equal(floatingSrc.includes("sendPanelAction('workspace.setActive', { workspaceName: ws.workspaceName })"), false);
});

await log('record.start uses scope workspaceName', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('record.start', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined)"), true);
});

await log('play.start uses scope workspaceName', async () => {
    assert.equal(floatingSrc.includes("sendPanelAction('play.start', {}, activeWorkspaceName ? { workspaceName: activeWorkspaceName } : undefined)"), true);
});

await log('onAction rejects payload.workspaceName', async () => {
    assert.equal(entrySrc.includes("'workspaceName' in normalizedPayload"), true);
    assert.equal(entrySrc.includes("message: 'payload.workspaceName is not allowed'"), true);
});
