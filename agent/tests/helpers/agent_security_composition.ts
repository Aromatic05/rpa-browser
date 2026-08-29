import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PageSnapshotSessionStore} from '../../src/automation/snapshot';
import type {RunStepsDeps} from '../../src/automation/runner/run_steps_types';
import type {StepUnion} from '../../src/automation/runner/steps/types';
import type {WorkspaceAgentFactoryDeps} from '../../src/automation/runtime/workspace/agent';
import type {WorkspaceEntityRulesProvider} from '../../src/automation/snapshot/rules/runtime/contracts';
import type {WorkflowEntityRules} from '../../src/automation/workflow';
import {createPortAllocator} from '../../src/automation/runtime/service/ports';
import {createWorkspaceAgentFactory} from '../../src/agent/workspace/factory';
import type {WorkspaceAgentService} from '../../src/agent/service/runtime';
import {createAgentServiceSecurity} from '../../src/agent/service/security';
import type {AgentServiceSecurityOptions} from '../../src/agent/service/security/contracts';
import {
    CAPABILITIES,
    createBearerAuthenticator,
    createCredentialRef,
    createRedactionPolicy,
    serializeCredentialRef,
} from '../../src/security';
import type {CredentialResolver} from '../../src/security/credentials';
import type {Principal} from '../../src/security/context';
import {defaultRunnerConfig} from '../../src/platform/config/defaults';
import {completeRunStepsDeps} from './run_steps_workspace';
import {createV2BusinessPage} from './v2_business_page';
import {createFauxAgentModelRuntime} from './agent_factory_harness';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import type {AgentModelRuntime} from '../../src/agent/model/runtime';

export const SECURITY_CANARY = 'tok_security_e2e_canary_7f2a9c';

let harnessCounter = 0;

export const apiTokenRefString = (): string =>
    serializeCredentialRef(createCredentialRef({id: 'env:API_TOKEN', kind: 'token', provider: 'env'}));

export const missingTokenRefString = (): string =>
    serializeCredentialRef(createCredentialRef({id: 'env:MISSING_TOKEN', kind: 'token', provider: 'env'}));

export const AGENT_PRINCIPAL: Principal = Object.freeze({
    id: 'rpa-agent',
    kind: 'service',
    scopes: ['agent.run'],
});

export const createAuthSecurity = (token: string): AgentServiceSecurityOptions | undefined =>
    createAgentServiceSecurity({
        authenticator: createBearerAuthenticator({
            verify: async (candidate: string) => (candidate === token ? AGENT_PRINCIPAL : null),
        }),
        redactionPolicy: createRedactionPolicy({secrets: [token]}),
        capabilities: {run: CAPABILITIES.AGENT_RUN},
    }) ?? undefined;

export const countingResolver = (resolvedIds: string[]): CredentialResolver => ({
    resolve: async (ref) => {
        resolvedIds.push(ref.id);
        if (ref.id !== 'env:API_TOKEN') {
            throw Object.assign(new Error(`credential not found: ${ref.id}`), {code: 'ERR_SECURITY_CREDENTIAL_NOT_FOUND'});
        }
        return SECURITY_CANARY;
    },
    has: (ref) => ref.id === 'env:API_TOKEN',
    describe: (ref) => `credential:${ref.id}`,
});

export const denyAllResolver = (): CredentialResolver => ({
    resolve: async () => {
        throw Object.assign(new Error('credential resolution is denied'), {code: 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE'});
    },
    has: () => false,
    describe: (ref) => `credential:${ref.id}`,
});

const emptyCheckpointProvider = {
    getCheckpoint: () => null,
    getCheckpointResolves: () => null,
    getCheckpointBody: () => null,
    listCheckpoints: () => [],
};

export type BrowserCall = {
    name: string;
    args: Record<string, unknown>;
};

export type BrowserWorldOptions = {
    calls?: BrowserCall[];
    failFill?: boolean;
    failClick?: boolean;
};

export const secretRulesProvider: WorkspaceEntityRulesProvider = {
    availability: 'ready',
    workflowName: 'security-e2e',
    listProfiles: () => ['secret-page'],
    getProfile: (name) => ({kind: 'entity_rules', name, match: {}, annotation: {}}) as unknown as WorkflowEntityRules,
    resolveExports: (profileName) => ({
        index: {
            profileName,
            entities: [{
                profileName,
                entityKey: 'secretForm',
                businessTag: 'secret.form',
                kind: 'form',
                fields: [{
                    fieldKey: 'secret',
                    targetKind: 'form.field',
                    effect: {reversibility: 'reversible'},
                }],
                actions: [{
                    actionIntent: 'submit',
                    targetKind: 'form.action',
                    effect: {reversibility: 'irreversible'},
                }],
                columns: [],
                rowActions: [],
                supportedQueries: ['form.fields', 'form.actions'],
                members: [
                    {kind: 'field', symbol: 'secret'},
                    {kind: 'action', symbol: 'submit'},
                ],
            }],
            resolve: (entityKey, symbol) =>
                entityKey === 'secretForm' && (symbol === 'submit' || symbol === 'secret')
                    ? {kind: symbol === 'submit' ? 'action' : 'field', symbol}
                    : undefined,
        },
        diagnostics: [],
    }),
};

export const REVERSIBLE_SOURCE = [
    'use entity_rules "secret-page" as page',
    'fill page.secretForm.secret with input.value',
    'output done = input.done',
].join('\n');

export const IRREVERSIBLE_SOURCE = [
    'use entity_rules "secret-page" as page',
    'click page.secretForm.submit',
    'output done = input.done',
].join('\n');

export type SecurityWorkspace = {
    workspaceName: string;
    deps: RunStepsDeps;
    worldViewSource: {pin: () => Promise<unknown>};
    tabs: WorkspaceAgentFactoryDeps['tabs'];
};

export const buildSecurityWorkspace = async (
    options: BrowserWorldOptions = {},
): Promise<SecurityWorkspace> => {
    const calls = options.calls ?? [];
    const pluginHost = {
        getExecutors: () => ({
            'browser.query': async (step: StepUnion) => ({
                stepId: step.id,
                ok: true,
                data: {kind: 'nodeId', nodeId: 'secret-field', meta: {}},
            }),
            'browser.fill': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                if (options.failFill) {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_FILL', message: 'fill failed'},
                    };
                }
                return {stepId: step.id, ok: true, data: {filled: true}};
            },
            'browser.click': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args as unknown as Record<string, unknown>});
                if (options.failClick) {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_CLICK', message: 'click failed'},
                    };
                }
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
        }),
    } as unknown as RunStepsDeps['pluginHost'];

    const page = {url: () => '/secret-form'} as unknown as Parameters<PageSnapshotSessionStore<object>['ensureFresh']>[0]['pageKey'];
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: page,
        pageUrl: '/secret-form',
        capture: async () => fixture.capture,
    });
    const worldView = Object.freeze({
        workspaceName: 'security-e2e',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });

    const pageSession: RunStepsDeps['pageSession'] = {
        read: (pageKey) => (pageKey === page ? entry : undefined),
        readFreshness: (pageKey, pageUrl) => (pageKey === page && pageUrl === '/secret-form'
            ? {status: 'fresh' as const}
            : {status: 'missing' as const, refreshReason: 'missing-snapshot' as const}),
        markDirty: () => undefined,
        ensureFresh: async () => entry,
        createAnchor: () => undefined,
        resolveAnchor: () => ({status: 'stale' as const, evidence: []}),
        confirmSelection: () => ({ok: false as const, reason: 'missing-session' as const}),
        clearSelection: () => undefined,
        readSelection: () => ({status: 'none' as const}),
        resolveSelectionForObservation: () => ({status: 'none' as const}),
        upsertManualSemanticBinding: () => ({ok: false as const, reason: 'missing-session' as const}),
        ignoreManualSemanticBindings: () => ({ok: false as const, reason: 'missing-session' as const}),
    };

    const deps = completeRunStepsDeps({
        pluginHost,
        resolveEntityRulesProvider: () => secretRulesProvider,
        pageSession,
    } as never);
    const baseWorkspace = deps.resolveWorkspace('security-e2e');
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyCheckpointProvider},
        entityRules: {getProvider: () => secretRulesProvider},
    })) as never;

    const tabs = {
        getActiveTab: () => ({
            tabId: 'tab-1',
            name: 'main',
            page,
            binding: 'bound',
            url: '/secret-form',
            title: '',
            createdAt: 0,
            updatedAt: 0,
        }),
        getTab: () => null,
        hasTab: () => false,
        listTabs: () => [],
        resolveTab: () => null,
        setActiveTab: () => undefined,
        createTab: () => null,
        awaitTabPage: async () => page,
        createTabPage: async () => page,
        bindPage: () => null,
        closeTab: async () => null,
        updateTab: () => null,
        reportTab: () => null,
        pingTab: () => null,
        reassignTab: () => null,
    } as unknown as WorkspaceAgentFactoryDeps['tabs'];

    return {
        workspaceName: 'security-e2e',
        deps,
        worldViewSource: {pin: async () => worldView},
        tabs,
    };
};

export type SecurityHarnessOptions = {
    interaction?: 'interactive' | 'headless';
    dataDir?: string;
    security?: AgentServiceSecurityOptions;
    credentialResolver?: CredentialResolver;
    portBegin?: number;
    browserWorld?: SecurityWorkspace;
    modelRuntime?: AgentModelRuntime;
};

export type SecurityHarness = {
    service: WorkspaceAgentService;
    workspaceName: string;
    provider: string;
    model: string;
    start: () => Promise<number>;
    stop: () => Promise<void>;
};

export type ProgramProposal = {
    source: string;
    input?: Record<string, unknown>;
    provider?: string;
    model?: string;
};

export const createProgramProposingModelRuntime = (
    proposal: ProgramProposal,
    provider = 'openai',
    model = 'gpt-4.1',
): {runtime: AgentModelRuntime; provider: string; model: string} => {
    const faux = createFauxCore({provider, models: [{id: model}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: proposal.source,
            input: structuredClone(proposal.input ?? {}),
        })),
        fauxAssistantMessage('Completed through the program transaction.'),
    ]);
    const runtime: AgentModelRuntime = {
        resolve: (requestedProvider, requestedModel) =>
            requestedProvider === provider && requestedModel === model
                ? {
                    model: faux.getModel() as never,
                    streamFn: faux.streamSimple,
                    getApiKey: () => 'test-key',
                }
                : null,
    };
    return {runtime, provider, model};
};

export const buildSecurityHarness = async (
    options: SecurityHarnessOptions = {},
): Promise<SecurityHarness> => {
    const faux = options.modelRuntime
        ? {runtime: options.modelRuntime, provider: 'openai', model: 'gpt-4.1'}
        : createFauxAgentModelRuntime();
    const world = options.browserWorld ?? await buildSecurityWorkspace();
    const config = structuredClone(defaultRunnerConfig);
    const portBegin = (options.portBegin ?? 29400) + harnessCounter * 50;
    harnessCounter += 1;
    const portAllocator = createPortAllocator(portBegin);
    const tabs = world.tabs;
    const factory = createWorkspaceAgentFactory({
        modelRuntime: faux.runtime,
        credentialResolver: options.credentialResolver,
        security: options.security,
        interaction: options.interaction,
        dataDir: options.dataDir,
    });
    const binding = factory({
        workspaceName: world.workspaceName,
        tabs,
        runStepsDeps: world.deps,
        runnerConfig: config,
        portAllocator,
        runWorkspaceExecution: async (_actionType, run) => await run(),
    });
    const service = binding.service as WorkspaceAgentService;
    return {
        service,
        workspaceName: world.workspaceName,
        provider: faux.provider,
        model: faux.model,
        start: async () => (await service.start()).port,
        stop: async () => {await service.stop();},
    };
};

export const mkdtempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const withBearer = (token: string | undefined): Record<string, string> =>
    token === undefined ? {'content-type': 'application/json'} : {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
    };

export const scanForString = (root: string, needle: string): string[] => {
    const hits: string[] = [];
    const visit = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(full);
                continue;
            }
            if (!entry.isFile()) {continue;}
            try {
                const raw = fs.readFileSync(full, 'utf8');
                if (raw.includes(needle)) {hits.push(full);}
            } catch {
                // unreadable files are skipped
            }
        }
    };
    visit(root);
    return hits;
};

export const randomWorkspaceName = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;