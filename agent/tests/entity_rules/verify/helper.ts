import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
import { getLogger, initLogger } from '../../../src/logging/logger';
import { loadRunnerConfig } from '../../../src/config/loader';
import { defaultEntityRuleConfig } from '../../../src/config/entity_rules';
import { generateSemanticSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { normalizeText } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { createEntityRuleFixtureRoot } from '../profile_fixture';

const entityLog = getLogger('entity');

export type EntityRuleVerifyCase = {
    profile: string;
    app: 'ant' | 'element';
    pagePath: string;
};

export const verifyEntityRuleGoldenCase = async (testCase: EntityRuleVerifyCase) => {
    const actual = await collectEntityRuleActual(testCase);
    const profileDir = path.resolve(process.cwd(), 'tests/entity_rules/profiles', testCase.profile);
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
    const browser = await chromium.launch({ headless: true });
    const fixture = await createEntityRuleFixtureRoot();

    try {
        const page = await browser.newPage();
        const url = `${mockServer.baseUrl}${testCase.pagePath}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const snapshot = await generateSemanticSnapshot(page, {
            entityRuleConfig: {
                ...defaultEntityRuleConfig,
                enabled: true,
                rootDir: fixture.rootDir,
                selection: 'explicit',
                profiles: [testCase.profile],
                strict: true,
            },
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
        await fixture.cleanup();
        await browser.close();
        await mockServer.close();
    }
};

const startMockApp = async (app: 'ant' | 'element'): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
    const rootDir = path.resolve(process.cwd(), '../mock');
    const packageName = app === 'ant' ? '@mock/ant-app' : '@mock/element-app';
    const port = await getFreePort();

    const proc = spawn(
        'pnpm',
        ['-C', rootDir, '--filter', packageName, 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
            cwd: rootDir,
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
            const leftKey = `${left.businessTag || ''}:${left.nodeDomId || ''}:${left.kind}`;
            const rightKey = `${right.businessTag || ''}:${right.nodeDomId || ''}:${right.kind}`;
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
