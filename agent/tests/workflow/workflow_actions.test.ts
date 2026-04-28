import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workflowHandlers } from '../../src/actions/workflow';
import { createRecordingState } from '../../src/record/recording';

const workflowsRoot = path.resolve(process.cwd(), 'agent/.artifacts/workflows');

const ensureScene = (scene: string, dslSource = '') => {
    const sceneDir = path.join(workflowsRoot, scene);
    fs.mkdirSync(path.join(sceneDir, 'dsl'), { recursive: true });
    fs.writeFileSync(
        path.join(sceneDir, 'workflow.yaml'),
        [
            'version: 1',
            `id: ${scene}`,
            'entry:',
            '  dsl: dsl/main.dsl',
            'records:',
            '  - records/default',
            'checkpoints:',
            '  - checkpoints/check-a',
        ].join('\n'),
        'utf8',
    );
    fs.writeFileSync(path.join(sceneDir, 'dsl', 'main.dsl'), dslSource, 'utf8');
    fs.mkdirSync(path.join(sceneDir, 'records', 'default'), { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'records', 'default', 'steps.yaml'), 'version: 1\nsteps: []\n', 'utf8');
    fs.mkdirSync(path.join(sceneDir, 'checkpoints', 'check-a'), { recursive: true });
    fs.writeFileSync(
        path.join(sceneDir, 'checkpoints', 'check-a', 'checkpoint.yaml'),
        'version: 1\ncheckpoint:\n  id: check-a\n  trigger:\n    matchRules:\n      - errorCode: ERR_SAMPLE\n  output:\n    ok:\n      ref: input.ok\n',
        'utf8',
    );
    return sceneDir;
};

const createCtx = () => {
    const workspaces = new Map<string, { activeTabId?: string; tabIds: string[] }>();
    const recordingState = createRecordingState();
    const pageRegistry: any = {
        listWorkspaces: () =>
            Array.from(workspaces.entries()).map(([workspaceId, value]) => ({
                workspaceId,
                activeTabId: value.activeTabId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                tabCount: value.tabIds.length,
            })),
        createWorkspaceShell: (workspaceId: string) => {
            if (!workspaces.has(workspaceId)) {
                workspaces.set(workspaceId, { tabIds: [] });
            }
            return { workspaceId };
        },
        createTab: async (workspaceId: string) => {
            const ws = workspaces.get(workspaceId) || { tabIds: [] };
            const tabId = `tab-${ws.tabIds.length + 1}`;
            ws.tabIds.push(tabId);
            ws.activeTabId = tabId;
            workspaces.set(workspaceId, ws);
            return tabId;
        },
        setActiveWorkspace: (_workspaceId: string) => {},
        setActiveTab: (workspaceId: string, tabId: string) => {
            const ws = workspaces.get(workspaceId);
            if (!ws) {return;}
            ws.activeTabId = tabId;
        },
        resolveTabToken: ({ workspaceId, tabId }: { workspaceId: string; tabId: string }) => `${workspaceId}:${tabId}`,
        getActiveWorkspace: () => {
            const first = Array.from(workspaces.entries())[0];
            if (!first) {return null;}
            return { workspaceId: first[0], activeTabId: first[1].activeTabId };
        },
        resolvePage: async () => ({
            url: () => 'about:blank',
            goto: async () => {},
        }),
    };

    return {
        ctx: {
            pageRegistry,
            recordingState,
            tabToken: 'token-test',
            runStepsDeps: {
                runtime: {
                    ensureActivePage: async () => ({
                        workspaceId: 'workflow:test',
                        tabId: 'tab-1',
                        tabToken: 'workflow:test:tab-1',
                    }),
                },
                stepSinks: [],
                config: {},
                pluginHost: undefined,
            } as any,
        } as any,
        workspaces,
        recordingState,
    };
};

test('workflow actions list/open/dsl get save/test/release and record save', async (t) => {
    const scene = `scene-${Date.now()}`;
    const sceneDir = ensureScene(scene, '');
    t.after(() => {
        fs.rmSync(sceneDir, { recursive: true, force: true });
    });

    const { ctx, recordingState } = createCtx();

    const listed = await workflowHandlers['workflow.list'](ctx, { v: 1, id: '1', type: 'workflow.list' } as any);
    assert.equal(listed.type, 'workflow.list.result');
    assert.equal(Array.isArray((listed.payload as any).workflows), true);
    assert.equal((listed.payload as any).workflows.some((item: any) => item.scene === scene), true);

    const opened = await workflowHandlers['workflow.open'](ctx, {
        v: 1,
        id: '2',
        type: 'workflow.open',
        payload: { scene },
    } as any);
    assert.equal(opened.type, 'workflow.open.result');
    assert.equal((opened.payload as any).workspaceId, `workflow:${scene}`);

    const dslGet = await workflowHandlers['workflow.dsl.get'](ctx, {
        v: 1,
        id: '3',
        type: 'workflow.dsl.get',
        payload: { scene },
    } as any);
    assert.equal(dslGet.type, 'workflow.dsl.get.result');
    assert.equal(typeof (dslGet.payload as any).content, 'string');

    const dslSave = await workflowHandlers['workflow.dsl.save'](ctx, {
        v: 1,
        id: '4',
        type: 'workflow.dsl.save',
        payload: { scene, content: '' },
    } as any);
    assert.equal(dslSave.type, 'workflow.dsl.save.result');

    recordingState.recordings.set('rec-a', []);
    recordingState.workspaceLatestRecording.set(`workflow:${scene}`, 'rec-a');
    const recordSaved = await workflowHandlers['workflow.record.save'](ctx, {
        v: 1,
        id: '5',
        type: 'workflow.record.save',
        scope: { workspaceId: `workflow:${scene}` },
        payload: { scene, recordingName: 'rec-main' },
    } as any);
    assert.equal(recordSaved.type, 'workflow.record.save.result');
    assert.equal(
        fs.existsSync(path.join(sceneDir, 'records', 'rec-main', 'steps.yaml')),
        true,
    );
    assert.equal(
        fs.existsSync(path.join(sceneDir, 'records', 'rec-main', 'step_resolve.yaml')),
        false,
    );

    const dslTest = await workflowHandlers['workflow.dsl.test'](ctx, {
        v: 1,
        id: '6',
        type: 'workflow.dsl.test',
        payload: { scene, input: { a: 1 } },
    } as any);
    assert.equal(dslTest.type, 'workflow.dsl.test.result');

    const releaseRun = await workflowHandlers['workflow.releaseRun'](ctx, {
        v: 1,
        id: '7',
        type: 'workflow.releaseRun',
        payload: { scene, input: { b: 2 } },
    } as any);
    assert.equal(releaseRun.type, 'workflow.releaseRun.result');
});
