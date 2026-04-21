import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { getLogger, initLogger } from '../../../src/logging/logger';
import { loadRunnerConfig } from '../../../src/config/loader';
import { defaultEntityRuleConfig } from '../../../src/config/entity_rules';
import { generateSemanticSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { normalizeText } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';

const entityLog = getLogger('entity');

const serveFile = async (rootDir: string, reqUrl: string): Promise<{ status: number; body: Buffer; contentType: string }> => {
    const normalizedPath = reqUrl === '/' ? '/pages/start.html' : reqUrl;
    const filePath = path.join(rootDir, normalizedPath);
    if (!existsSync(filePath)) {
        return {
            status: 404,
            body: Buffer.from('Not found'),
            contentType: 'text/plain; charset=utf-8',
        };
    }

    const body = await fs.readFile(filePath);
    const contentType = resolveContentType(filePath);
    return {
        status: 200,
        body,
        contentType,
    };
};

const startMockServer = async (): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
    const rootDir = path.resolve(process.cwd(), '../mock');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const served = await serveFile(rootDir, url.pathname);
        res.writeHead(served.status, { 'Content-Type': served.contentType });
        res.end(served.body);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('mock server address unavailable');
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
};

const resolveContentType = (filePath: string): string => {
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
    return 'application/octet-stream';
};

export type EntityRuleVerifyCase = {
    profile: string;
    pagePath: string;
};

export const verifyEntityRuleGoldenCase = async (testCase: EntityRuleVerifyCase) => {
    const actual = await collectEntityRuleActual(testCase);
    const profileDir = path.resolve(process.cwd(), '.artifacts/entity_rules/profiles', testCase.profile);
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

    const mockServer = await startMockServer();
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        const url = `${mockServer.baseUrl}${testCase.pagePath}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const snapshot = await generateSemanticSnapshot(page, {
            entityRuleConfig: {
                ...defaultEntityRuleConfig,
                enabled: true,
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
        await browser.close();
        await mockServer.close();
    }
};

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
                nodeDomId: normalizeText(snapshot.attrIndex[entity.nodeId]?.backendDOMNodeId),
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
        nodeDomId?: string;
        fieldKey?: string;
        actionIntent?: string;
        entityKind?: string;
        entityNodeDomId?: string;
        name?: string;
    }> = [];

    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        const fieldKey = normalizeText(attrs.fieldKey);
        const actionIntent = normalizeText(attrs.actionIntent);
        if (!fieldKey && !actionIntent) continue;

        const entityNodeId = normalizeText(attrs.entityNodeId);
        const entityNodeDomId = entityNodeId ? normalizeText(snapshot.attrIndex[entityNodeId]?.backendDOMNodeId) : undefined;

        out.push(
            compactValue({
                nodeDomId: normalizeText(attrs.backendDOMNodeId),
                fieldKey,
                actionIntent,
                entityKind: normalizeText(attrs.entityKind),
                entityNodeDomId,
                name: normalizeText(snapshot.nodeIndex[nodeId]?.name),
            }),
        );
    }

    return out.sort((left, right) => {
        const leftKey = `${left.nodeDomId || ''}:${left.fieldKey || ''}:${left.actionIntent || ''}`;
        const rightKey = `${right.nodeDomId || ''}:${right.fieldKey || ''}:${right.actionIntent || ''}`;
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
            if (compacted === undefined) continue;
            out[key] = compacted;
        }
        return out as T;
    }
    return value;
};
