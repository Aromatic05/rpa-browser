import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promises as fsp} from 'node:fs';
import {chromium, type Page} from 'playwright';
import type {AgentModelRuntime} from '../../src/agent/model/runtime';
import {createWorkspaceHarness} from './workspace_harness';
import {ensureWorkflowOnFs} from '../../src/automation/workflow';
import type {
    EntityRulePageApplicability,
    EntityRuleMatchArtifact,
    EntityRuleAnnotationArtifact,
} from '../../src/automation/workflow/entity_rules';
import {stepExecutors} from '../../src/automation/runner/steps/executors';
import {runStepList, readResultPipe} from '../../src/automation/runner/run_steps';
import type {RunStepsDeps} from '../../src/automation/runner/run_steps_types';
import type {StepUnion} from '../../src/automation/runner/steps/types';
import type {AgentServiceSecurityOptions} from '../../src/agent/service/security/contracts';
import type {WorkspaceAgentService} from '../../src/agent/service/runtime';
import type {WorkspaceRegistry} from '../../src/automation/runtime/workspace/registry';
import type {RuntimeWorkspace} from '../../src/automation/runtime/workspace/workspace';
import {
    newProductSmokeMatrix,
    recordEntry,
    writeProductSmokeMatrix,
    loadProductSmokeMatrix,
    type ProductSmokeMatrix,
    type SmokeEntry,
} from './agent_product_matrix';

/**
 * Real-browser + production-factory product smoke session.
 *
 * Launches one real Playwright Chromium, binds a real page into a real
 * workspace registry built with the production workspace agent factory, real
 * step executors, and a deterministic scripted model runtime. The agent's HTTP
 * service surface (run/sessions/interactions/report/cancel/auth) is exercised
 * through the production `createAgentHttpServer` over plain fetch.
 *
 * Owned smoke tests must verify the world externally (real DOM / service
 * responses), never via model self-report.
 */

export const PRODUCT_SMOKE_WORKSPACE = 'default';

export type EntityRulesProfileSpec = {
    profileName: string;
    page?: EntityRulePageApplicability;
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
};

export type ProductSmokeSessionOptions = {
    modelRuntime: AgentModelRuntime;
    dataDir?: string;
    interaction?: 'interactive' | 'headless';
    security?: AgentServiceSecurityOptions;
    headed?: boolean;
    workflowRoot?: string;
    useEntityRulesWorkflow?: boolean;
    entityRules?: EntityRulesProfileSpec[];
};

export type ProductSmokeSession = {
    page: Page;
    workspaceName: string;
    registry: WorkspaceRegistry;
    workspace: RuntimeWorkspace;
    runStepsDeps: RunStepsDeps;
    dataDir: string;
    workflowRoot: string;
    agent: WorkspaceAgentService;
    matrix: ProductSmokeMatrix;
    record: (entry: SmokeEntry) => void;
    flushMatrix: () => string;
    runSteps: (steps: StepUnion[]) => Promise<ResultPipeItem[]>;
    startService: () => Promise<number>;
    stop: () => Promise<void>;
};

const FIXTURES_DIR = path.resolve(process.cwd(), 'tests', 'fixtures');
const ENTITY_WORKFLOW_FIXTURE = path.resolve(FIXTURES_DIR, 'workflows', 'dsl_order_workflow');

export const fixtureUrl = (server: {baseURL: string}, pagePath: string): string =>
    `${server.baseURL}${pagePath}`;

export const openProductSmokeSession = async (
    options: ProductSmokeSessionOptions,
): Promise<ProductSmokeSession> => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpa-product-smoke-'));
    const dataDir = options.dataDir ?? path.join(tempRoot, 'data');
    const workflowRoot = options.workflowRoot ?? path.join(tempRoot, 'workflow');
    await fsp.mkdir(dataDir, {recursive: true});
    await fsp.mkdir(workflowRoot, {recursive: true});
    process.env.RPA_WORKFLOW_ROOT = workflowRoot;

    if (options.useEntityRulesWorkflow) {
        await fsp.cp(ENTITY_WORKFLOW_FIXTURE, path.join(workflowRoot, PRODUCT_SMOKE_WORKSPACE), {
            recursive: true,
        });
    }

    const workflow = ensureWorkflowOnFs(PRODUCT_SMOKE_WORKSPACE);

    for (const profile of options.entityRules ?? []) {
        workflow.save({
            kind: 'entity_rules',
            name: profile.profileName,
            ...(profile.page ? {page: profile.page} : {}),
            match: profile.match,
            annotation: profile.annotation,
        });
    }

    const browser = await chromium.launch({
        headless: options.headed ? false : process.env.RPA_PRODUCT_SMOKE_HEADED !== '1',
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage({viewport: {width: 960, height: 720}});

    const harness = createWorkspaceHarness({
        getPage: async () => page,
        pluginHost: {getExecutors: () => stepExecutors} as never,
        agentModelRuntime: options.modelRuntime,
        agentFactoryOptions: {
            dataDir,
            ...(options.interaction ? {interaction: options.interaction} : {}),
            ...(options.security ? {security: options.security} : {}),
        },
    });
    const workspace = harness.registry.createWorkspace(PRODUCT_SMOKE_WORKSPACE, workflow);
    workspace.tabs.createTab({tabName: 'main'});
    workspace.tabs.bindPage('main', page);
    harness.runStepsDeps.resolveEntityRulesProvider = (name: string) => {
        const target = harness.registry.getWorkspace(name);
        return target ? target.entityRules.getProvider(target.workflow) : null;
    };

    const matrix = newProductSmokeMatrix();
    const record = (entry: SmokeEntry): void => {
        recordEntry(matrix, entry);
    };

    const flushMatrix = (): string => {
        const existing = loadProductSmokeMatrix();
        return writeProductSmokeMatrix(matrix, existing ? {merge: existing} : {});
    };

    const session: ProductSmokeSession = {
        page,
        workspaceName: PRODUCT_SMOKE_WORKSPACE,
        registry: harness.registry,
        workspace,
        runStepsDeps: harness.runStepsDeps,
        dataDir,
        workflowRoot,
        agent: workspace.agent as WorkspaceAgentService,
        matrix,
        record,
        flushMatrix,
        runSteps: async (steps) => {
            const {pipe} = await runStepList(PRODUCT_SMOKE_WORKSPACE, steps, harness.runStepsDeps);
            return readResultPipe(pipe).items.map((item) => ({
                stepId: item.stepId,
                ok: item.ok,
                data: item.data,
                error: item.error,
            }));
        },
        startService: async () => (await workspace.agent.start()).port,
        stop: async () => {
            await workspace.agent.stop().catch(() => undefined);
            await browser.close();
            await fsp.rm(tempRoot, {recursive: true, force: true}).catch(() => undefined);
        },
    };
    return session;
};

type ResultPipeItem = {
    stepId: string;
    ok: boolean;
    data?: unknown;
    error?: {code?: string; message?: string};
};

export type {ResultPipeItem};

export const runStepResult = async (
    session: ProductSmokeSession,
    step: StepUnion,
): Promise<ResultPipeItem> => {
    const results = await session.runSteps([step]);
    return results[0];
};

export const st = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, {name: T}>['args'],
): Extract<StepUnion, {name: T}> => ({id, name, args} as unknown as Extract<StepUnion, {name: T}>);

export const newStepId = (): string => `product-smoke-${crypto.randomUUID()}`;

export const httpBase = (port: number): string => `http://127.0.0.1:${String(port)}`;

export const bearerHeaders = (token: string | undefined): Record<string, string> =>
    token === undefined
        ? {'content-type': 'application/json'}
        : {'content-type': 'application/json', authorization: `Bearer ${token}`};