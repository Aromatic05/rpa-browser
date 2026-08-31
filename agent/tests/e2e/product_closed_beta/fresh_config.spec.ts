import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {startClosedBetaSession} from '../../helpers/product_closed_beta/session';
import {
    flushClosedBetaMatrix,
    newClosedBetaMatrix,
    passRow,
    failRow,
    type ClosedBetaMatrix,
} from '../../helpers/product_closed_beta/matrix';

/**
 * Closed-beta acceptance item 1: fresh configuration carries only the normal
 * workspace session config (workspaceName/wsPort); the product path uses the
 * `agent.product` Action over the trusted workspace WebSocket — no
 * rpaProductBaseUrl and no HTTP bearer anywhere in extension storage or the
 * shipped bundle.
 */

const matrix: ClosedBetaMatrix = newClosedBetaMatrix();

const repoRoot = path.resolve(process.cwd(), '..');
const extensionDist = (): string => {
    const stampPath = path.join(repoRoot, '.dev', 'extension-build.json');
    try {
        const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as {mainExtensionPath?: unknown};
        if (typeof stamp.mainExtensionPath === 'string' && fs.existsSync(stamp.mainExtensionPath)) {
            return stamp.mainExtensionPath;
        }
    } catch {
        // fall through to the fixed dist directory
    }
    return path.join(repoRoot, 'extension', 'dist');
};

const collectTextFiles = (root: string): string[] => {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && /\.(js|mjs|json)$/u.test(entry.name)) {
                files.push(full);
            }
        }
    };
    walk(root);
    return files;
};

const countToken = (root: string, token: string): number =>
    collectTextFiles(root).reduce((total, file) => total + countOccurrences(fs.readFileSync(file, 'utf8'), token), 0);

const countOccurrences = (text: string, token: string): number => {
    let count = 0;
    let index = 0;
    while (index >= 0) {
        index = text.indexOf(token, index);
        if (index >= 0) {
            count += 1;
            index += token.length;
        }
    }
    return count;
};

test.describe('closed-beta: fresh configuration / WS product transport', () => {
    test.describe.configure({mode: 'serial', timeout: 300_000});

    test('fresh config has only workspaceName/wsPort; bundle carries no product HTTP base URL or bearer', async () => {
        const dist = extensionDist();
        const sessionConfig = path.join(dist, 'background', 'session_config.js');
        expect(fs.existsSync(sessionConfig), `session_config.js exists at ${sessionConfig}`).toBe(true);

        const wsStorageKeys = countToken(dist, 'rpaWorkspaceName') + countToken(dist, 'rpaWsPort');
        const noBaseUrl = countToken(dist, 'rpaProductBaseUrl');
        const noReadBaseUrl = countToken(dist, 'readProductBaseUrl');
        const noAuthorization = countToken(dist, 'Authorization');
        const noBearer = countToken(dist, 'Bearer');
        const wsProductAction = countToken(dist, 'agent.product');

        const passed = wsStorageKeys >= 1
            && noBaseUrl === 0
            && noReadBaseUrl === 0
            && noAuthorization === 0
            && noBearer === 0
            && wsProductAction >= 1;

        if (passed) {
            matrix.rows.push(passRow(
                'cb.fresh-config',
                'item 1: fresh config is only workspaceName/wsPort; Product goes over agent.product Action/WS without base URL or bearer',
                [
                    `bundle(stamped dist) keeps session storage keys rpaWorkspaceName/rpaWsPort`,
                    `bundle carries agent.product Action surface (${wsProductAction} refs)`,
                    `bundle has 0 rpaProductBaseUrl / readProductBaseUrl / Authorization / Bearer occurrences`,
                ],
            ));
        } else {
            matrix.rows.push(failRow(
                'cb.fresh-config',
                'item 1: fresh config is only workspaceName/wsPort; Product goes over agent.product Action/WS without base URL or bearer',
                'shipped extension bundle violates the no-product-HTTP-config contract',
                [
                    `dist=${dist}`,
                    `rpaWorkspaceName+rpaWsPort=${wsStorageKeys}`,
                    `rpaProductBaseUrl=${noBaseUrl}`,
                    `readProductBaseUrl=${noReadBaseUrl}`,
                    `Authorization=${noAuthorization}`,
                    `Bearer=${noBearer}`,
                    `agent.product=${wsProductAction}`,
                ],
            ));
        }
        expect(passed, JSON.stringify({
            dist,
            wsStorageKeys,
            noBaseUrl,
            noReadBaseUrl,
            noAuthorization,
            noBearer,
            wsProductAction,
        })).toBe(true);
    });

    test('a fresh agent answers agent.product workspaceView over WS with zero config and no bearer anywhere', async () => {
        const session = await startClosedBetaSession();
        try {
            const view = await session.product({verb: 'workspaceView'}) as {
                workspace?: string;
                reservation?: {owner?: string};
            };
            const list = await session.product({verb: 'listTasks'}) as {
                active?: unknown[];
                history?: unknown[];
            };

            const passed = view.workspace === 'default'
                && view.reservation?.owner === 'none'
                && Array.isArray(list.active)
                && list.active.length === 0;
            if (passed) {
                matrix.rows.push(passRow(
                    'cb.fresh-config.ws-workspace',
                    'item 1: agent.product workspaceView/listTasks answer over the trusted WS before any config is injected',
                    [
                        `workspaceView.workspace=${JSON.stringify(view.workspace)}`,
                        `workspaceView.reservation.owner=${JSON.stringify(view.reservation?.owner)}`,
                        `listTasks.active.length=0`,
                    ],
                ));
            } else {
                matrix.rows.push(failRow(
                    'cb.fresh-config.ws-workspace',
                    'item 1: agent.product workspaceView/listTasks answer over the trusted WS before any config is injected',
                    `fresh WS product surface mis-project: ${JSON.stringify({view, list})}`,
                    [JSON.stringify({view, list})],
                ));
            }
            expect(passed, JSON.stringify({view, list})).toBe(true);
        } finally {
            await session.close();
            flushClosedBetaMatrix(matrix);
        }
    });
});