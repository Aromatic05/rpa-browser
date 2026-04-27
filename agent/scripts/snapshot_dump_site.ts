import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/collect';
import { generateSemanticSnapshotFromRaw } from '../src/runner/steps/executors/snapshot/snapshot';

type DumpPayload = {
    sourceUrl: string;
    finalUrl: string;
    title: string;
    capturedAt: string;
    domTree: unknown;
    a11yTree: unknown;
};

const DEFAULT_VIEWER_API_BASE = 'http://127.0.0.1:5173';

const countNodes = (node: unknown): number => {
    if (!node || typeof node !== 'object') {return 0;}
    const children = Array.isArray((node as { children?: unknown[] }).children)
        ? ((node as { children?: unknown[] }).children as unknown[])
        : [];
    return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
};

const main = async () => {
    const url = process.argv[2] || 'https://catos.info';
    const outputFile =
        process.argv[3] ||
        path.join(os.tmpdir(), 'rpa-snapshot', 'site.raw.json');
    const viewerApiBase = (
        process.argv[4] ||
        process.env.RPA_SNAPSHOT_VIEWER_API ||
        DEFAULT_VIEWER_API_BASE
    ).trim();

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

        const raw = await collectRawData(page);
        const payload: DumpPayload = {
            sourceUrl: url,
            finalUrl: page.url(),
            title: await page.title(),
            capturedAt: new Date().toISOString(),
            domTree: raw.domTree,
            a11yTree: raw.a11yTree,
        };
        const snapshot = generateSemanticSnapshotFromRaw({
            domTree: payload.domTree,
            a11yTree: payload.a11yTree,
        });
        const snapshotFile = outputFile.endsWith('.raw.json')
            ? outputFile.replace(/\.raw\.json$/, '.snapshot.json')
            : `${outputFile}.snapshot.json`;

        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        await fs.writeFile(outputFile, JSON.stringify(payload, null, 2), 'utf8');
        await fs.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');

        let ingest: unknown = undefined;
        if (viewerApiBase) {
            const endpoint = `${viewerApiBase.replace(/\/+$/, '')}/api/capture/ingest`;
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        label: 'site-snapshot',
                        sourceUrl: payload.sourceUrl,
                        finalUrl: payload.finalUrl,
                        title: payload.title,
                        capturedAt: payload.capturedAt,
                        raw: {
                            domTree: payload.domTree,
                            a11yTree: payload.a11yTree,
                        },
                        snapshot,
                        meta: {
                            script: 'snapshot_dump_site.ts',
                        },
                    }),
                });
                ingest = await response.json();
            } catch (cause) {
                ingest = { ok: false, error: String(cause) };
            }
        }

        console.log(
            JSON.stringify(
                {
                    outputFile,
                    snapshotFile,
                    viewerApiBase: viewerApiBase || undefined,
                    ingest,
                    finalUrl: payload.finalUrl,
                    domCount: countNodes(payload.domTree),
                    a11yCount: countNodes(payload.a11yTree),
                    snapshotCount: countNodes(snapshot.root),
                },
                null,
                2,
            ),
        );
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
