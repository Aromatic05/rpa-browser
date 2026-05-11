import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRuntimeLifecycle } from '../../src/runtime/browser/lifecycle';
import { createWorkspaceHarness } from '../helpers/workspace_harness';
import { createRecordingState, enableWorkspaceRecording, getWorkspaceUnsavedToken, resetWorkspaceUnsavedRecording } from '../../src/record/recording';
import { createWorkflowOnFs } from '../../src/workflow';

const createMockPage = (url: string) =>
    ({
        url: () => url,
        on: () => undefined,
        mainFrame: () => ({ url: () => url }),
        frames: () => [],
        context: () => ({}) as any,
        exposeBinding: async () => undefined,
        addInitScript: async () => undefined,
        waitForTimeout: async () => undefined,
        evaluate: async () => undefined,
        goto: async () => undefined,
        isClosed: () => false,
        close: async () => undefined,
    }) as any;

test('onPageBound records create_tab for newly bound tab when recording enabled', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-create-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    workspace.tabs.setActiveTab('tab-old');
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });

    lifecycle.onPageBound(createMockPage('https://new-tab'), 'tab-new');
    const token = getWorkspaceUnsavedToken(recordingState, workspaceName);
    const steps = recordingState.recordings.get(token) || [];
    assert.equal(steps.some((step) => step.name === 'browser.create_tab'), true);
});

test('onPageBound records switch_tab after create_tab when active changes', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-switch-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    workspace.tabs.setActiveTab('tab-old');
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });

    lifecycle.onPageBound(createMockPage('https://new-tab'), 'tab-new');
    const token = getWorkspaceUnsavedToken(recordingState, workspaceName);
    const steps = recordingState.recordings.get(token) || [];
    assert.equal(steps.length >= 2, true);
    assert.equal(steps[0].name, 'browser.create_tab');
    assert.equal(steps[1].name, 'browser.switch_tab');
    assert.deepEqual(steps[0].args, { tabName: 'tab-new' });
    assert.deepEqual(steps[1].args, { tabName: 'tab-new' });
});

test('onPageBound does not use create_tab to imply active switch conditions', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-existing-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-existing', page: createMockPage('https://existing'), url: 'https://existing' });
    workspace.tabs.setActiveTab('tab-existing');
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });

    lifecycle.onPageBound(createMockPage('https://existing-2'), 'tab-existing');
    const token = getWorkspaceUnsavedToken(recordingState, workspaceName);
    const steps = recordingState.recordings.get(token) || [];
    assert.equal(steps.some((step) => step.name === 'browser.create_tab'), false);
    assert.equal(steps.some((step) => step.name === 'browser.switch_tab'), false);
});

test('onBindingClosed records close_tab for manually closed tab', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-close-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-close', page: createMockPage('https://close'), url: 'https://close' });
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });
    lifecycle.onBindingClosed('tab-close');
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.some((step) => step.name === 'browser.close_tab'), true);
    assert.equal(steps.some((step) => step.name === 'browser.switch_tab'), false);
});

test('onBindingClosed records close_tab before cleanupRecording', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-cleanup-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-close', page: createMockPage('https://close'), url: 'https://close' });
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    let closeRecordedBeforeCleanup = false;
    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => {
            const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
            closeRecordedBeforeCleanup = steps.some((step) => step.name === 'browser.close_tab');
        },
    });
    lifecycle.onBindingClosed('tab-close');
    assert.equal(closeRecordedBeforeCleanup, true);
});

test('onBindingClosed for non-active tab records close_tab only', () => {
    const recordingState = createRecordingState();
    const { registry, runStepsDeps } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-lifecycle-close-non-active-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({ tabName: 'tab-active', page: createMockPage('https://active'), url: 'https://active' });
    workspace.tabs.createTab({ tabName: 'tab-close', page: createMockPage('https://close'), url: 'https://close' });
    workspace.tabs.setActiveTab('tab-active');
    resetWorkspaceUnsavedRecording(recordingState, workspaceName);
    enableWorkspaceRecording(recordingState, workspaceName);

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: registry,
        runtimeRegistry: runStepsDeps.runtime as any,
        recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 30000,
        pingWatchdogIntervalMs: 10000,
        emit: () => undefined,
        ensureWorkflow: (name) => registry.getWorkspace(name)?.workflow || workspace.workflow,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        isWorkspaceRecordingEnabled: (state, name) => state.recordingEnabled.has(getWorkspaceUnsavedToken(state, name)),
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });
    lifecycle.onBindingClosed('tab-close');
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.filter((step) => step.name === 'browser.close_tab').length, 1);
    assert.equal(steps.some((step) => step.name === 'browser.switch_tab'), false);
});
