import assert from 'node:assert/strict';
import { classifyPanelAction, preparePanelAction } from '../../dist/content/panel_actions.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

await log('workspace actions are classified correctly', async () => {
    assert.equal(classifyPanelAction('tab.list'), 'workspace');
    assert.equal(classifyPanelAction('record.start'), 'workspace');
    assert.equal(classifyPanelAction('play.start'), 'workspace');
    assert.equal(classifyPanelAction('dsl.save'), 'workspace');
    assert.equal(classifyPanelAction('checkpoint.list'), 'workspace');
    assert.equal(classifyPanelAction('entity_rules.delete'), 'workspace');
    assert.equal(classifyPanelAction('task.run.once'), 'workspace');
});

await log('control actions are classified correctly', async () => {
    assert.equal(classifyPanelAction('workspace.list'), 'control');
    assert.equal(classifyPanelAction('workspace.create'), 'control');
    assert.equal(classifyPanelAction('workspace.setActive'), 'control');
    assert.equal(classifyPanelAction('workflow.list'), 'control');
    assert.equal(classifyPanelAction('workflow.create'), 'control');
    assert.equal(classifyPanelAction('workflow.open'), 'control');
});

await log('workspace action requires selected workspaceName', async () => {
    const prepared = preparePanelAction('record.start', {}, null);
    assert.equal('error' in prepared, true);
    if ('error' in prepared) {
        assert.equal(prepared.error.type, 'record.start.failed');
        assert.equal(prepared.error.workspaceName, undefined);
    }
});

await log('workspace action uses top-level workspaceName and payload tabName only', async () => {
    const prepared = preparePanelAction('tab.setActive', { tabName: 'tab-1' }, 'ws-1');
    assert.equal('error' in prepared, false);
    if (!('error' in prepared)) {
        assert.deepEqual(prepared.address, { workspaceName: 'ws-1' });
        assert.deepEqual(prepared.payload, { tabName: 'tab-1' });
        assert.equal('workspaceName' in (prepared.payload ?? {}), false);
        assert.equal('scope' in (prepared.payload ?? {}), false);
        assert.equal('tabToken' in (prepared.payload ?? {}), false);
    }
});

await log('control action keeps workspaceName out of scope and payload', async () => {
    const prepared = preparePanelAction('workflow.list', {}, 'ws-1');
    assert.equal('error' in prepared, false);
    if (!('error' in prepared)) {
        assert.equal(prepared.address, undefined);
        assert.deepEqual(prepared.payload, {});
    }
});

await log('workflow.saveAs and workflow.resetDefault are control actions', async () => {
    assert.equal(classifyPanelAction('workflow.saveAs'), 'control');
    assert.equal(classifyPanelAction('workflow.resetDefault'), 'control');
    const prepared = preparePanelAction('workflow.saveAs', { sourceName: 'default', targetName: 'x' }, null);
    assert.equal('error' in prepared, false);
    if (!('error' in prepared)) {
        assert.equal(prepared.address, undefined);
        assert.deepEqual(prepared.payload, { sourceName: 'default', targetName: 'x' });
    }
});
