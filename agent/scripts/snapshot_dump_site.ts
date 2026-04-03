import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/collect';

type DumpPayload = {
    sourceUrl: string;
    finalUrl: string;
    title: string;
    capturedAt: string;
    domTree: unknown;
    a11yTree: unknown;
};

const countNodes = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const children = Array.isArray((node as { children?: unknown[] }).children)
        ? ((node as { children?: unknown[] }).children as unknown[])
        : [];
    return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
};

const main = async () => {
    const url = process.argv[2] || 'https://catos.info';
    const outputFile =
        process.argv[3] ||
        path.resolve(process.cwd(), 'tests/fixtures/snapshot/catos.info.raw.json');

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

        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        await fs.writeFile(outputFile, JSON.stringify(payload, null, 2), 'utf8');

        console.log(
            JSON.stringify(
                {
                    outputFile,
                    finalUrl: payload.finalUrl,
                    domCount: countNodes(payload.domTree),
                    a11yCount: countNodes(payload.a11yTree),
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
