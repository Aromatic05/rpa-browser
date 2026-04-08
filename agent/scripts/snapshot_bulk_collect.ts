import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/stages/collect';
import { generateSemanticSnapshotFromRaw } from '../src/runner/steps/executors/snapshot/pipeline/snapshot';

type CollectPayload = {
    sourceUrl: string;
    finalUrl: string;
    title: string;
    capturedAt: string;
    round: number;
    domTree: unknown;
    a11yTree: unknown;
};

type ManifestItem = {
    id: string;
    sourceUrl: string;
    finalUrl?: string;
    title?: string;
    capturedAt?: string;
    round: number;
    rawFile?: string;
    snapshotFile?: string;
    error?: string;
};

type CliOptions = {
    input?: string;
    sitemap?: string;
    outDir: string;
    limit: number;
    repeat: number;
    concurrency: number;
    timeoutMs: number;
    headless: boolean;
    withSnapshot: boolean;
    storageState?: string;
};

type ParsedArgs = {
    help: boolean;
    options: CliOptions;
};

type Task = {
    url: string;
    round: number;
    index: number;
};

const DEFAULT_OUT_DIR = path.join(os.tmpdir(), 'rpa-snapshot-bulk');

const main = async () => {
    const parsedArgs = parseArgs(process.argv.slice(2));
    if (parsedArgs.help) {
        printUsage();
        return;
    }
    const options = parsedArgs.options;
    const urls = await loadUrls(options);
    if (urls.length === 0) {
        throw new Error('no urls found. use --input <file> or --sitemap <url>');
    }

    const limited = options.limit > 0 ? urls.slice(0, options.limit) : urls;
    const tasks = buildTasks(limited, options.repeat);

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(options.outDir, runId);
    const rawDir = path.join(runDir, 'raw');
    const snapshotDir = path.join(runDir, 'snapshot');
    await fs.mkdir(rawDir, { recursive: true });
    if (options.withSnapshot) {
        await fs.mkdir(snapshotDir, { recursive: true });
    }

    const browser = await chromium.launch({ headless: options.headless });
    try {
        const context = await createContext(browser, options.storageState);
        try {
            const manifest = await runTasks({
                context,
                tasks,
                rawDir,
                snapshotDir,
                withSnapshot: options.withSnapshot,
                timeoutMs: options.timeoutMs,
                concurrency: options.concurrency,
            });

            const summary = buildSummary(manifest, runId, runDir, options, limited.length);
            await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
            await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
            await fs.writeFile(path.join(runDir, 'urls.txt'), `${limited.join('\n')}\n`, 'utf8');

            console.log(
                JSON.stringify(
                    {
                        runDir,
                        ...summary,
                    },
                    null,
                    2,
                ),
            );
        } finally {
            await context.close();
        }
    } finally {
        await browser.close();
    }
};

const createContext = async (
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    storageState: string | undefined,
): Promise<BrowserContext> => {
    if (storageState) {
        return browser.newContext({
            storageState,
        });
    }
    return browser.newContext();
};

const runTasks = async (input: {
    context: BrowserContext;
    tasks: Task[];
    rawDir: string;
    snapshotDir: string;
    withSnapshot: boolean;
    timeoutMs: number;
    concurrency: number;
}): Promise<ManifestItem[]> => {
    const { context, tasks, rawDir, snapshotDir, withSnapshot, timeoutMs } = input;
    const concurrency = Math.max(1, input.concurrency);
    const queue = [...tasks];
    const manifest: ManifestItem[] = [];

    const worker = async () => {
        while (queue.length > 0) {
            const task = queue.shift();
            if (!task) break;
            const record = await collectTask(context, task, {
                rawDir,
                snapshotDir,
                withSnapshot,
                timeoutMs,
            });
            manifest.push(record);
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
    manifest.sort((a, b) => a.id.localeCompare(b.id));
    return manifest;
};

const collectTask = async (
    context: BrowserContext,
    task: Task,
    options: {
        rawDir: string;
        snapshotDir: string;
        withSnapshot: boolean;
        timeoutMs: number;
    },
): Promise<ManifestItem> => {
    const id = buildCaptureId(task.index, task.url, task.round);
    const page = await context.newPage();
    const result: ManifestItem = {
        id,
        sourceUrl: task.url,
        round: task.round,
    };

    try {
        await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
        const raw = await collectRawData(page);
        const payload: CollectPayload = {
            sourceUrl: task.url,
            finalUrl: page.url(),
            title: await page.title(),
            capturedAt: new Date().toISOString(),
            round: task.round,
            domTree: raw.domTree,
            a11yTree: raw.a11yTree,
        };
        const rawFile = path.join(options.rawDir, `${id}.raw.json`);
        await fs.writeFile(rawFile, JSON.stringify(payload), 'utf8');

        result.finalUrl = payload.finalUrl;
        result.title = payload.title;
        result.capturedAt = payload.capturedAt;
        result.rawFile = rawFile;

        if (options.withSnapshot) {
            const snapshot = generateSemanticSnapshotFromRaw({
                domTree: payload.domTree,
                a11yTree: payload.a11yTree,
            });
            const snapshotFile = path.join(options.snapshotDir, `${id}.snapshot.json`);
            await fs.writeFile(snapshotFile, JSON.stringify(snapshot), 'utf8');
            result.snapshotFile = snapshotFile;
        }
    } catch (cause) {
        result.error = String(cause);
    } finally {
        await page.close().catch(() => undefined);
    }

    return result;
};

const buildSummary = (
    manifest: ManifestItem[],
    runId: string,
    runDir: string,
    options: CliOptions,
    uniqueUrlCount: number,
) => {
    const successCount = manifest.filter((item) => !item.error).length;
    const failedCount = manifest.length - successCount;
    return {
        runId,
        runDir,
        totalTasks: manifest.length,
        uniqueUrlCount,
        successCount,
        failedCount,
        repeat: options.repeat,
        concurrency: options.concurrency,
        withSnapshot: options.withSnapshot,
    };
};

const buildTasks = (urls: string[], repeat: number): Task[] => {
    const tasks: Task[] = [];
    const rounds = Math.max(1, repeat);
    let index = 0;
    for (let round = 0; round < rounds; round += 1) {
        for (const url of urls) {
            tasks.push({
                url,
                round,
                index,
            });
            index += 1;
        }
    }
    return tasks;
};

const loadUrls = async (options: CliOptions): Promise<string[]> => {
    if (options.input) {
        const content = await fs.readFile(options.input, 'utf8');
        return dedupUrls(
            content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#')),
        );
    }
    if (options.sitemap) {
        return loadUrlsFromSitemap(options.sitemap);
    }
    return [];
};

const loadUrlsFromSitemap = async (sitemapUrl: string): Promise<string[]> => {
    const visited = new Set<string>();
    const pageUrls: string[] = [];
    const queue: Array<{ url: string; depth: number }> = [{ url: sitemapUrl, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (visited.has(current.url)) continue;
        visited.add(current.url);

        const xml = await fetchText(current.url);
        const locs = extractXmlLocs(xml);
        for (const loc of locs) {
            const normalized = normalizeUrl(loc);
            if (!normalized) continue;
            if (normalized.endsWith('.xml') && current.depth < 2) {
                queue.push({ url: normalized, depth: current.depth + 1 });
                continue;
            }
            pageUrls.push(normalized);
        }
    }

    return dedupUrls(pageUrls);
};

const fetchText = async (url: string): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`fetch failed: ${url} status=${response.status}`);
    }
    return response.text();
};

const extractXmlLocs = (xml: string): string[] => {
    const matches = xml.matchAll(/<loc>(.*?)<\/loc>/gsi);
    const urls: string[] = [];
    for (const match of matches) {
        const value = decodeXml(match[1] || '');
        if (value) urls.push(value);
    }
    return urls;
};

const decodeXml = (value: string): string => {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
};

const buildCaptureId = (index: number, url: string, round: number): string => {
    const hash = crypto.createHash('sha1').update(`${url}|${round}`).digest('hex').slice(0, 10);
    return `${String(index).padStart(6, '0')}_r${round}_${hash}`;
};

const normalizeUrl = (value: string): string | undefined => {
    const text = value.trim();
    if (!text) return undefined;
    try {
        const parsed = new URL(text);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return undefined;
    }
};

const dedupUrls = (urls: string[]): string[] => {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const url of urls) {
        const normalized = normalizeUrl(url);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(normalized);
    }
    return deduped;
};

const parseArgs = (argv: string[]): ParsedArgs => {
    const options: CliOptions = {
        outDir: DEFAULT_OUT_DIR,
        limit: 0,
        repeat: 1,
        concurrency: 4,
        timeoutMs: 45_000,
        headless: true,
        withSnapshot: false,
    };
    let help = false;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            help = true;
            continue;
        }
        if (arg === '--input') {
            options.input = argv[++i];
            continue;
        }
        if (arg === '--sitemap') {
            options.sitemap = argv[++i];
            continue;
        }
        if (arg === '--out') {
            options.outDir = argv[++i] || DEFAULT_OUT_DIR;
            continue;
        }
        if (arg === '--limit') {
            options.limit = parseInt(argv[++i] || '0', 10) || 0;
            continue;
        }
        if (arg === '--repeat') {
            options.repeat = Math.max(1, parseInt(argv[++i] || '1', 10) || 1);
            continue;
        }
        if (arg === '--concurrency') {
            options.concurrency = Math.max(1, parseInt(argv[++i] || '4', 10) || 4);
            continue;
        }
        if (arg === '--timeout') {
            options.timeoutMs = Math.max(5_000, parseInt(argv[++i] || '45000', 10) || 45_000);
            continue;
        }
        if (arg === '--headless') {
            const raw = (argv[++i] || 'true').toLowerCase();
            options.headless = raw !== 'false' && raw !== '0';
            continue;
        }
        if (arg === '--with-snapshot') {
            options.withSnapshot = true;
            continue;
        }
        if (arg === '--storage-state') {
            options.storageState = argv[++i];
            continue;
        }
    }

    return { help, options };
};

const printUsage = () => {
    console.log(
        [
            'snapshot_bulk_collect.ts',
            '',
            'Usage:',
            '  pnpm snapshot:bulk:collect -- --input <urls.txt> [--out <dir>] [--repeat 3] [--concurrency 6]',
            '  pnpm snapshot:bulk:collect -- --sitemap <https://site/sitemap.xml> [--limit 5000]',
            '',
            'Options:',
            '  --input <file>          URL list file, one URL per line',
            '  --sitemap <url>         sitemap url, supports nested sitemap index',
            '  --out <dir>             output directory (default: /tmp/rpa-snapshot-bulk)',
            '  --limit <n>             max unique urls (0 means unlimited)',
            '  --repeat <n>            capture rounds per url',
            '  --concurrency <n>       parallel pages',
            '  --timeout <ms>          page goto timeout',
            '  --with-snapshot         also save .snapshot.json',
            '  --storage-state <file>  playwright storage state json',
            '  --headless <true|false> launch headless mode',
        ].join('\n'),
    );
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
