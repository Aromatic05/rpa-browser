import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSemanticSnapshotFromRaw } from '../src/runner/steps/executors/snapshot/pipeline/snapshot';
import type { EntityIndex, GroupEntity, SnapshotResult, UnifiedNode } from '../src/runner/steps/executors/snapshot/core/types';

type RawPayload = {
    sourceUrl?: string;
    finalUrl?: string;
    capturedAt?: string;
    round?: number;
    domTree: unknown;
    a11yTree: unknown;
};

type CliOptions = {
    inputDir: string;
    outputFile: string;
    limit: number;
    minItems: number;
    badTop: number;
};

type GroupEvalRecord = {
    rawFile: string;
    sourceUrl?: string;
    finalUrl?: string;
    capturedAt?: string;
    round: number;
    groupId: string;
    containerId: string;
    kind: GroupEntity['kind'];
    keySlot: number;
    itemCount: number;
    keyCoverage: number;
    keyUniqueness: number;
    score: number;
    sampleKeys: string[];
};

type StabilityRecord = {
    sourceUrl: string;
    kind: GroupEntity['kind'];
    containerId: string;
    samples: number;
    keySlotMode: number;
    keySlotStability: number;
};

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    if (!options.inputDir) {
        printUsage();
        throw new Error('missing --input-dir');
    }

    const rawFiles = await collectRawFiles(options.inputDir);
    if (rawFiles.length === 0) {
        throw new Error(`no .raw.json files under ${options.inputDir}`);
    }

    const limitedFiles = options.limit > 0 ? rawFiles.slice(0, options.limit) : rawFiles;
    const records: GroupEvalRecord[] = [];

    for (let i = 0; i < limitedFiles.length; i += 1) {
        const file = limitedFiles[i];
        const payload = await readRawPayload(file);
        if (!payload) {continue;}
        const snapshot = generateSemanticSnapshotFromRaw({
            domTree: payload.domTree,
            a11yTree: payload.a11yTree,
        });
        const groups = evaluateGroups(snapshot, file, payload, options.minItems);
        records.push(...groups);

        if ((i + 1) % 50 === 0) {
            console.log(`[keyslot-eval] processed ${i + 1}/${limitedFiles.length}`);
        }
    }

    const summary = buildSummary(records, limitedFiles.length);
    const stability = evaluateStability(records);

    const report = {
        summary,
        worstGroups: [...records].sort((a, b) => a.score - b.score).slice(0, options.badTop),
        unstableGroups: stability
            .sort((a, b) => a.keySlotStability - b.keySlotStability)
            .slice(0, options.badTop),
    };

    await fs.mkdir(path.dirname(options.outputFile), { recursive: true });
    await fs.writeFile(options.outputFile, JSON.stringify(report, null, 2), 'utf8');

    console.log(
        JSON.stringify(
            {
                outputFile: options.outputFile,
                rawFileCount: limitedFiles.length,
                groupCount: summary.groupCount,
                avgScore: summary.avgScore,
                unstableGroupCount: report.unstableGroups.length,
            },
            null,
            2,
        ),
    );
};

const evaluateGroups = (
    snapshot: SnapshotResult,
    rawFile: string,
    payload: RawPayload,
    minItems: number,
): GroupEvalRecord[] => {
    const groups = Object.values(snapshot.entityIndex.entities).filter(
        (entity): entity is GroupEntity => entity.type === 'group',
    );
    if (groups.length === 0) {return [];}

    const slotMap = buildGroupSlotMap(snapshot.entityIndex);
    const records: GroupEvalRecord[] = [];

    for (const group of groups) {
        if (group.itemIds.length < minItems) {continue;}

        const keyTexts: string[] = [];
        for (const itemId of group.itemIds) {
            const text = resolveKeyText(snapshot, slotMap, group.id, itemId, group.keySlot);
            keyTexts.push(text || '');
        }

        const nonEmpty = keyTexts.filter((item) => item.trim().length > 0);
        const coverage = group.itemIds.length > 0 ? nonEmpty.length / group.itemIds.length : 0;
        const unique = new Set(nonEmpty.map((item) => normalizeLower(item)));
        const uniqueness = nonEmpty.length > 0 ? unique.size / nonEmpty.length : 0;
        const score = 0.6 * uniqueness + 0.4 * coverage;

        records.push({
            rawFile,
            sourceUrl: payload.sourceUrl,
            finalUrl: payload.finalUrl,
            capturedAt: payload.capturedAt,
            round: payload.round || 0,
            groupId: group.id,
            containerId: group.containerId,
            kind: group.kind,
            keySlot: group.keySlot,
            itemCount: group.itemIds.length,
            keyCoverage: roundNum(coverage),
            keyUniqueness: roundNum(uniqueness),
            score: roundNum(score),
            sampleKeys: nonEmpty.slice(0, 8),
        });
    }

    return records;
};

const buildSummary = (records: GroupEvalRecord[], rawFileCount: number) => {
    const groupCount = records.length;
    const avgScore = groupCount > 0 ? roundNum(records.reduce((sum, item) => sum + item.score, 0) / groupCount) : 0;
    const highQuality = records.filter((item) => item.score >= 0.85).length;
    const lowQuality = records.filter((item) => item.score < 0.55).length;

    const byKind: Record<GroupEntity['kind'], number> = {
        table: 0,
        kv: 0,
        list: 0,
    };
    for (const record of records) {
        byKind[record.kind] += 1;
    }

    return {
        rawFileCount,
        groupCount,
        avgScore,
        highQuality,
        lowQuality,
        byKind,
    };
};

const evaluateStability = (records: GroupEvalRecord[]): StabilityRecord[] => {
    const byGroupKey = new Map<string, GroupEvalRecord[]>();
    for (const record of records) {
        const sourceUrl = record.sourceUrl || '';
        if (!sourceUrl) {continue;}
        const key = `${sourceUrl}|${record.kind}|${record.containerId}`;
        const bucket = byGroupKey.get(key) || [];
        bucket.push(record);
        byGroupKey.set(key, bucket);
    }

    const stability: StabilityRecord[] = [];
    for (const [key, bucket] of byGroupKey) {
        if (bucket.length < 2) {continue;}
        const [sourceUrl, kind, containerId] = key.split('|');
        const slotCounter = new Map<number, number>();
        for (const record of bucket) {
            slotCounter.set(record.keySlot, (slotCounter.get(record.keySlot) || 0) + 1);
        }
        const sorted = [...slotCounter.entries()].sort((a, b) => b[1] - a[1]);
        const top = sorted[0];
        if (!top) {continue;}

        stability.push({
            sourceUrl,
            kind: kind as GroupEntity['kind'],
            containerId,
            samples: bucket.length,
            keySlotMode: top[0],
            keySlotStability: roundNum(top[1] / bucket.length),
        });
    }
    return stability;
};

const buildGroupSlotMap = (entityIndex: EntityIndex): Map<string, Map<string, Map<number, string[]>>> => {
    const map = new Map<string, Map<string, Map<number, string[]>>>();
    for (const [nodeId, refs] of Object.entries(entityIndex.byNodeId || {})) {
        if (!refs || refs.length === 0) {continue;}
        for (const ref of refs) {
            if (ref.type !== 'group') {continue;}
            if (ref.slotIndex === undefined) {continue;}
            if (!ref.itemId) {continue;}

            const byItem = map.get(ref.entityId) || new Map<string, Map<number, string[]>>();
            const bySlot = byItem.get(ref.itemId) || new Map<number, string[]>();
            const nodes = bySlot.get(ref.slotIndex) || [];
            nodes.push(nodeId);
            bySlot.set(ref.slotIndex, nodes);
            byItem.set(ref.itemId, bySlot);
            map.set(ref.entityId, byItem);
        }
    }
    return map;
};

const resolveKeyText = (
    snapshot: SnapshotResult,
    slotMap: Map<string, Map<string, Map<number, string[]>>>,
    groupId: string,
    itemId: string,
    keySlot: number,
): string | undefined => {
    const byItem = slotMap.get(groupId);
    const bySlot = byItem?.get(itemId);
    const nodeIds = bySlot?.get(keySlot) || [];
    if (nodeIds.length > 0) {
        for (const nodeId of nodeIds) {
            const text = resolveNodeText(snapshot, nodeId);
            if (text) {return text;}
        }
    }

    const itemNode = snapshot.nodeIndex[itemId];
    if (!itemNode) {return undefined;}
    return firstReadableText(snapshot, itemNode, 2);
};

const resolveNodeText = (snapshot: SnapshotResult, nodeId: string): string | undefined => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return undefined;}
    const attrs = snapshot.attrIndex[nodeId] || {};
    const inlineContent = resolveContent(snapshot, node);
    const candidates = [
        node.name,
        inlineContent,
        attrs['aria-label'],
        attrs['title'],
        attrs['placeholder'],
        attrs['value'],
        attrs['id'],
    ];

    for (const candidate of candidates) {
        const text = normalizeText(candidate);
        if (!text) {continue;}
        if (text.length > 120) {continue;}
        return text;
    }
    return undefined;
};

const firstReadableText = (snapshot: SnapshotResult, node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {break;}
        const own = resolveNodeText(snapshot, current.node.id);
        if (own && own.length <= 96) {return own;}

        if (current.depth >= depthLimit) {continue;}
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const resolveContent = (snapshot: SnapshotResult, node: UnifiedNode): string | undefined => {
    if (!node.content) {return undefined;}
    if (typeof node.content === 'string') {return node.content;}
    if (node.content.ref) {return snapshot.contentStore[node.content.ref];}
    return undefined;
};

const collectRawFiles = async (inputDir: string): Promise<string[]> => {
    const files: string[] = [];
    const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (entry.isFile() && fullPath.endsWith('.raw.json')) {
                files.push(fullPath);
            }
        }
    };
    await walk(inputDir);
    files.sort();
    return files;
};

const readRawPayload = async (file: string): Promise<RawPayload | undefined> => {
    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RawPayload;
        if (!parsed || typeof parsed !== 'object') {return undefined;}
        if (!parsed.domTree || !parsed.a11yTree) {return undefined;}
        return parsed;
    } catch {
        return undefined;
    }
};

const parseArgs = (argv: string[]): CliOptions => {
    const options: CliOptions = {
        inputDir: '',
        outputFile: '',
        limit: 0,
        minItems: 2,
        badTop: 200,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (arg === '--input-dir') {
            options.inputDir = argv[++i] || '';
            continue;
        }
        if (arg === '--output') {
            options.outputFile = argv[++i] || '';
            continue;
        }
        if (arg === '--limit') {
            options.limit = parseInt(argv[++i] || '0', 10) || 0;
            continue;
        }
        if (arg === '--min-items') {
            options.minItems = Math.max(2, parseInt(argv[++i] || '2', 10) || 2);
            continue;
        }
        if (arg === '--bad-top') {
            options.badTop = Math.max(10, parseInt(argv[++i] || '200', 10) || 200);
            continue;
        }
    }

    if (!options.outputFile && options.inputDir) {
        options.outputFile = path.join(options.inputDir, 'keyslot_eval_report.json');
    }
    return options;
};

const printUsage = () => {
    console.log(
        [
            'snapshot_eval_keyslot.ts',
            '',
            'Usage:',
            '  pnpm snapshot:keyslot:eval -- --input-dir <dataset-dir>',
            '',
            'Options:',
            '  --input-dir <dir>   root directory containing many .raw.json files',
            '  --output <file>     report output json path',
            '  --limit <n>         max raw files to process (0 means unlimited)',
            '  --min-items <n>     minimum group item count for evaluation',
            '  --bad-top <n>       output top-N worst / unstable groups',
        ].join('\n'),
    );
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized ? normalized : undefined;
};

const normalizeLower = (value: string): string => value.toLowerCase().trim();
const roundNum = (value: number): number => Math.round(value * 10000) / 10000;

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
