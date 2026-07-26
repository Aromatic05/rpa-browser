import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { getLogger, initLogger } from '../../../../src/logging/logger';
import { loadRunnerConfig } from '../../../../src/config/loader';
import { defaultEntityRuleConfig } from '../../../../src/config/entity_rules';
import { loadEntityRules } from '../../../../src/runner/steps/executors/snapshot/entity_rules/loader';
import type { WorkspaceEntityRulesProvider } from '../../../../src/entity_rules/provider';
import { generateSemanticSnapshot } from '../../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { buildFinalEntityViewFromSnapshot } from '../../../../src/runner/steps/executors/snapshot/core/overlay';
import { normalizeText } from '../../../../src/runner/steps/executors/snapshot/core/runtime_store';
import type { FinalEntityView, SnapshotResult } from '../../../../src/runner/steps/executors/snapshot/core/types';
import { createEntityRuleFixtureRoot, entityRuleProfileDir } from '../profile_fixture';

const entityLog = getLogger('entity');

export type EntityRuleVerifyCase = {
    profile: string;
    app: 'ant' | 'element';
    pagePath: string;
};


const createFixtureEntityRulesProvider = (
    rootDir: string,
    profile: string,
): WorkspaceEntityRulesProvider => {
    const resolve = (input: { pageKind?: any; pageUrl?: string } = {}) =>
        loadEntityRules({
            pageKind: input.pageKind,
            pageUrl: input.pageUrl,
            config: {
                ...defaultEntityRuleConfig,
                enabled: true,
                rootDir,
                selection: 'explicit',
                profiles: [profile],
                strict: true,
            },
        }).bundle || null;
    return {
        listBundles: () => {
            const bundle = resolve();
            return bundle ? [bundle] : [];
        },
        getBundle: (profileName) => profileName === profile ? resolve() : null,
        resolveBundle: resolve,
    };
};
export type EntityRuleSnapshotContext = {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
};

export const verifyEntityRuleGoldenCase = async (testCase: EntityRuleVerifyCase) => {
    const actual = await collectEntityRuleActual(testCase);
    const profileDir = entityRuleProfileDir(testCase.profile);
    const expectedFinalPath = path.join(profileDir, 'expected.final_entities.json');
    const expectedHintsPath = path.join(profileDir, 'expected.node_hints.json');

    const expectedFinalEntities = JSON.parse(await fs.readFile(expectedFinalPath, 'utf-8'));
    const expectedNodeHints = JSON.parse(await fs.readFile(expectedHintsPath, 'utf-8'));

    assertOrLogDiff(testCase.profile, 'final_entities', expectedFinalEntities, actual.finalEntities);
    assertOrLogDiff(testCase.profile, 'node_hints', expectedNodeHints, actual.nodeHints);
};

export const collectEntityRuleActual = async (testCase: EntityRuleVerifyCase) => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    config.observability.traceConsoleEnabled = false;
    config.observability.traceFileEnabled = false;
    initLogger(config);

    const mockServer = await startMockApp(testCase.app);
    let browser: Browser | null = null;
    let fixture: Awaited<ReturnType<typeof createEntityRuleFixtureRoot>> | null = null;

    try {
        browser = await chromium.launch({ headless: true });
        fixture = await createEntityRuleFixtureRoot();
        const page = await browser.newPage();
        const url = `${mockServer.baseUrl}${testCase.pagePath}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const snapshot = await generateSemanticSnapshot(page, {
            entityRulesProvider: createFixtureEntityRulesProvider(fixture.rootDir, testCase.profile),
        });

        const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
            renamedNodes: {},
            addedEntities: [],
            deletedEntities: [],
        });

        return {
            finalEntities: normalizeFinalEntities(snapshot, finalEntityView.entities),
            nodeHints: normalizeNodeHints(snapshot),
        };
    } finally {
        await fixture?.cleanup();
        await browser?.close();
        await mockServer.close();
    }
};

export const withEntityRuleSnapshotContext = async <T>(
    testCase: EntityRuleVerifyCase,
    callback: (context: EntityRuleSnapshotContext) => Promise<T>,
): Promise<T> => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    config.observability.traceConsoleEnabled = false;
    config.observability.traceFileEnabled = false;
    initLogger(config);

    const mockServer = await startMockApp(testCase.app);
    let browser: Browser | null = null;
    let fixture: Awaited<ReturnType<typeof createEntityRuleFixtureRoot>> | null = null;

    try {
        browser = await chromium.launch({ headless: true });
        fixture = await createEntityRuleFixtureRoot();
        const page = await browser.newPage();
        const url = `${mockServer.baseUrl}${testCase.pagePath}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const snapshot = await generateSemanticSnapshot(page, {
            entityRulesProvider: createFixtureEntityRulesProvider(fixture.rootDir, testCase.profile),
        });

        const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
            renamedNodes: {},
            addedEntities: [],
            deletedEntities: [],
        });

        return await callback({
            snapshot,
            finalEntityView,
        });
    } finally {
        await fixture?.cleanup();
        await browser?.close();
        await mockServer.close();
    }
};

export const startMockApp = async (app: 'ant' | 'element'): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
    const rootDir = path.resolve(process.cwd(), '../mock');
    const appDirName = app === 'ant' ? 'ant-app' : 'element-app';
    const packageName = app === 'ant' ? '@mock/ant-app' : '@mock/element-app';
    const appDir = path.join(rootDir, appDirName);
    const viteCli = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
    const port = await getFreePort();

    const proc = spawn(
        process.execPath,
        [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
            cwd: appDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        },
    );

    let stderr = '';
    let stdout = '';
    proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    try {
        await waitForHttpReady(`http://127.0.0.1:${port}/entity-rules`, 45000);
    } catch (error) {
        await stopProcess(proc);
        const reason = error instanceof Error ? error.message : 'unknown';
        throw new Error(`failed to start ${packageName} on ${port}: ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => stopProcess(proc),
    };
};

const getFreePort = async (): Promise<number> =>
    await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('no free port')));
                return;
            }
            const port = address.port;
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });

const waitForHttpReady = async (url: string, timeoutMs: number) => {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) {
                return;
            }
        } catch {
            // ignore
        }
        await sleep(200);
    }

    throw new Error(`timeout waiting for ${url}`);
};

const stopProcess = async (proc: ChildProcess): Promise<void> => {
    if (proc.killed || proc.exitCode !== null) {return;}

    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (!proc.killed && proc.exitCode === null) {
                proc.kill('SIGKILL');
            }
            resolve();
        }, 3000);
        proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const normalizeFinalEntities = (
    snapshot: Awaited<ReturnType<typeof generateSemanticSnapshot>>,
    entities: ReturnType<typeof buildFinalEntityViewFromSnapshot>['entities'],
) => {
    return entities
        .filter((entity) => entity.businessTag || entity.businessName)
        .map((entity) =>
            compactValue({
                kind: entity.kind,
                type: entity.type,
                name: normalizeText(entity.name),
                businessTag: normalizeText(entity.businessTag),
                businessName: normalizeText(entity.businessName),
                primaryKey: entity.primaryKey
                    ? {
                        fieldKey: entity.primaryKey.fieldKey,
                        columns: entity.primaryKey.columns ? [...entity.primaryKey.columns] : undefined,
                    }
                    : undefined,
                columns: entity.columns?.map((column) => compactValue({ fieldKey: column.fieldKey, name: normalizeText(column.name) })),
            }),
        )
        .sort((left, right) => {
            const leftKey = `${left.businessTag || ''}:${left.name || ''}:${left.kind}`;
            const rightKey = `${right.businessTag || ''}:${right.name || ''}:${right.kind}`;
            return leftKey.localeCompare(rightKey);
        });
};

const normalizeNodeHints = (snapshot: Awaited<ReturnType<typeof generateSemanticSnapshot>>) => {
    const out: Array<{
        fieldKey?: string;
        actionIntent?: string;
        entityKind?: string;
        name?: string;
    }> = [];

    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        const fieldKey = normalizeText(attrs.fieldKey);
        const actionIntent = normalizeText(attrs.actionIntent);
        if (!fieldKey && !actionIntent) {continue;}

        out.push(
            compactValue({
                fieldKey,
                actionIntent,
                entityKind: normalizeText(attrs.entityKind),
                name: normalizeText(snapshot.nodeIndex[nodeId]?.name),
            }),
        );
    }

    return out.sort((left, right) => {
        const leftKey = `${left.fieldKey || ''}:${left.actionIntent || ''}:${left.name || ''}`;
        const rightKey = `${right.fieldKey || ''}:${right.actionIntent || ''}:${right.name || ''}`;
        return leftKey.localeCompare(rightKey);
    });
};

const assertOrLogDiff = (
    profile: string,
    kind: 'final_entities' | 'node_hints',
    expected: unknown,
    actual: unknown,
) => {
    try {
        assert.deepEqual(actual, expected);
    } catch (error) {
        entityLog.error('entity.rules.verify.diff', {
            profile,
            kind,
            expected,
            actual,
            reason: error instanceof Error ? error.message : 'assert.deepEqual failed',
        });
        throw error;
    }
};

const compactValue = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value
            .map((item) => compactValue(item))
            .filter((item) => item !== undefined) as T;
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const compacted = compactValue(child);
            if (compacted === undefined) {continue;}
            out[key] = compacted;
        }
        return out as T;
    }
    return value;
};
