import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REQUEST_ACTION_TYPES as AGENT_REQUEST_ACTION_TYPES } from '../../src/actions/action_types';

const repoRoot = path.resolve(process.cwd(), '..');
const agentActionsDir = path.resolve(process.cwd(), 'src/actions');
const extensionActionsDir = path.resolve(repoRoot, 'extension/src/actions');

const expectedActionFiles = [
    'action_protocol.ts',
    'action_types.ts',
    'envelope.ts',
    'classify.ts',
    'results.ts',
    'control_gateway.ts',
    'workspace_gateway.ts',
    'dispatcher.ts',
    'ws_client.ts',
    'index.ts',
].sort();

const listTsFiles = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();

test('agent actions file set equals target gateway set', () => {
    assert.deepEqual(listTsFiles(agentActionsDir), expectedActionFiles);
});

test('extension actions file set equals target gateway set', () => {
    assert.deepEqual(listTsFiles(extensionActionsDir), expectedActionFiles);
});

test('legacy action gateway files are removed', () => {
    assert.equal(fs.existsSync(path.resolve(agentActionsDir, 'execute.ts')), false);
    assert.equal(fs.existsSync(path.resolve(agentActionsDir, 'error_codes.ts')), false);
    assert.equal(fs.existsSync(path.resolve(agentActionsDir, 'failure.ts')), false);
    assert.equal(fs.existsSync(path.resolve(extensionActionsDir, 'failure.ts')), false);
    assert.equal(fs.existsSync(path.resolve(extensionActionsDir, 'projection.ts')), false);
});

test('results modules expose required symbols', () => {
    const agentResultsSource = fs.readFileSync(path.resolve(agentActionsDir, 'results.ts'), 'utf8');
    assert.equal(agentResultsSource.includes('export const ERROR_CODES'), true);
    assert.equal(agentResultsSource.includes('export class ActionError'), true);
    assert.equal(agentResultsSource.includes('export const toFailedAction'), true);
    assert.equal(agentResultsSource.includes('export const unsupportedActionFailure'), true);

    const extensionResultsSource = fs.readFileSync(path.resolve(extensionActionsDir, 'results.ts'), 'utf8');
    assert.equal(extensionResultsSource.includes('export const mkActionDispatchFailed'), true);
    assert.equal(extensionResultsSource.includes('export const mkRequestFailedReply'), true);
});

test('projection moved out of extension actions gateway', () => {
    const backgroundProjectionPath = path.resolve(repoRoot, 'extension/src/background/projection.ts');
    assert.equal(fs.existsSync(backgroundProjectionPath), true);
    const cmdRouterSource = fs.readFileSync(path.resolve(repoRoot, 'extension/src/background/cmd_router.ts'), 'utf8');
    assert.equal(cmdRouterSource.includes("from './projection.js'"), true);
});

test('extension classify recognizes new dsl actions and rejects legacy workflow dsl actions', async () => {
    const mod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(mod.classifyRequestAction('workflow.dsl.get'), 'invalid');
    assert.equal(mod.classifyRequestAction('workflow.dsl.save'), 'invalid');
    assert.equal(mod.classifyRequestAction('workflow.dsl.test'), 'invalid');
    assert.equal(mod.classifyRequestAction('workflow.releaseRun'), 'invalid');
    assert.equal(mod.classifyRequestAction('dsl.get'), 'workspace');
    assert.equal(mod.classifyRequestAction('dsl.save'), 'workspace');
    assert.equal(mod.classifyRequestAction('dsl.test'), 'workspace');
    assert.equal(mod.classifyRequestAction('dsl.run'), 'workspace');
});

test('agent and extension request action catalogs are identical', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/action_types.ts'));
    const agentSet = new Set(Object.values(AGENT_REQUEST_ACTION_TYPES));
    const extensionSet = new Set(Object.values(extMod.REQUEST_ACTION_TYPES));
    assert.deepEqual([...extensionSet].sort(), [...agentSet].sort());
});
