import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/stages/collect';
import { fuseDomAndA11y } from '../src/runner/steps/executors/snapshot/stages/fusion';
import { buildSpatialLayers, isNoiseLayer } from '../src/runner/steps/executors/snapshot/stages/spatial';
import { detectRegions } from '../src/runner/steps/executors/snapshot/stages/regions';
import { detectStructureCandidates } from '../src/runner/steps/executors/snapshot/stages/entity_index';
import {
    selectStructureCandidatesWithDebug,
    type CandidateDecision,
    type StructureCandidate,
} from '../src/runner/steps/executors/snapshot/stages/candidates';
import { generateSemanticSnapshotFromRaw } from '../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { getNodeAttr } from '../src/runner/steps/executors/snapshot/core/runtime_store';
import type { RawData, UnifiedNode } from '../src/runner/steps/executors/snapshot/core/types';

type CliOptions = {
    url: string;
    timeoutMs: number;
    headless: boolean;
    outFile: string;
};

type DomNodeLike = {
    id?: string;
    tag?: string;
    attrs?: Record<string, string>;
    children?: DomNodeLike[];
};

type TableWrapperTruth = {
    domId: string;
    backendDomId?: string;
    className?: string;
    tableDescendantCount: number;
};

type TreeIndex = {
    nodeById: Map<string, UnifiedNode>;
    enterById: Map<string, number>;
    exitById: Map<string, number>;
};

type CandidateAggregate = {
    candidateByKey: Map<string, StructureCandidate>;
    decisionByKey: Map<string, CandidateDecision>;
};

type WrapperDropRecord = {
    domId: string;
    className?: string;
    tableDescendantCount: number;
    reason: string;
    candidateKey?: string;
    candidateNodeId?: string;
    candidateSource?: StructureCandidate['source'];
    candidateScore?: number;
    blockedByKey?: string;
    blockedByNodeId?: string;
    note?: string;
    selectedAncestorTableKey?: string;
    selectedAncestorTableNodeId?: string;
};

const DROP_REASON_PRIORITY: Record<string, number> = {
    cap: 4,
    conflict: 3,
    penalty_threshold: 2,
    threshold: 1,
    unknown: 0,
};

const DEFAULT_URL = 'https://ant.design/components/table';

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const browser = await chromium.launch({ headless: options.headless });

    try {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            try {
                await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

                const raw = await collectRawData(page);
                const wrappers = collectTableWrappers(raw.domTree);
                const aggregate = buildSelectionDiagnostics(raw);
                const tree = buildSelectionTree(raw);
                const snapshot = generateSemanticSnapshotFromRaw(raw);

                const report = buildReport({
                    url: options.url,
                    wrappers,
                    tree,
                    aggregate,
                    snapshot,
                });

                await fs.mkdir(path.dirname(options.outFile), { recursive: true });
                await fs.writeFile(options.outFile, JSON.stringify(report, null, 2), 'utf8');

                console.log(
                    JSON.stringify(
                        {
                            url: options.url,
                            outFile: options.outFile,
                            wrapperCount: report.summary.wrapperCount,
                            selectedWrapperCount: report.summary.selectedWrapperCount,
                            missedWrapperCount: report.summary.missedWrapperCount,
                            missReasonCount: report.summary.missReasonCount,
                            tableEntityCount: report.summary.tableEntityCount,
                        },
                        null,
                        2,
                    ),
                );
            } finally {
                await page.close().catch(() => undefined);
            }
        } finally {
            await context.close().catch(() => undefined);
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
};

const buildReport = (input: {
    url: string;
    wrappers: TableWrapperTruth[];
    tree: UnifiedNode;
    aggregate: CandidateAggregate;
    snapshot: ReturnType<typeof generateSemanticSnapshotFromRaw>;
}) => {
    const { wrappers, tree, aggregate, snapshot } = input;
    const index = indexTree(tree);
    const tableCandidates = [...aggregate.candidateByKey.values()].filter((candidate) => candidate.kind === 'table');

    const selectedByWrapper: Array<{
        domId: string;
        className?: string;
        tableDescendantCount: number;
        selected: Array<{
            key: string;
            nodeId: string;
            source: StructureCandidate['source'];
            score: number;
            note?: string;
        }>;
    }> = [];
    const droppedByWrapper: WrapperDropRecord[] = [];
    const missReasonCount: Record<string, number> = {};
    const tableDecisionReasonCount: Record<string, number> = {};

    for (const candidate of tableCandidates) {
        const decision = aggregate.decisionByKey.get(toCandidateKey(candidate));
        const reason = decision?.selected ? 'selected' : decision?.reason || 'unknown';
        tableDecisionReasonCount[reason] = (tableDecisionReasonCount[reason] || 0) + 1;
    }

    for (const wrapper of wrappers) {
        const node = index.nodeById.get(wrapper.domId);
        if (!node) {
            pushMissReason(missReasonCount, 'wrapper_missing_in_unified_tree');
            droppedByWrapper.push({
                domId: wrapper.domId,
                className: wrapper.className,
                tableDescendantCount: wrapper.tableDescendantCount,
                reason: 'wrapper_missing_in_unified_tree',
            });
            continue;
        }

        const relevant = tableCandidates.filter((candidate) => isDescendantOrSelf(wrapper.domId, candidate.nodeId, index));
        const selected = relevant
            .map((candidate) => ({ candidate, decision: aggregate.decisionByKey.get(toCandidateKey(candidate)) }))
            .filter((item) => item.decision?.selected)
            .sort((a, b) => compareCandidate(a.candidate, b.candidate))
            .map((item) => ({
                key: toCandidateKey(item.candidate),
                nodeId: item.candidate.nodeId,
                source: item.candidate.source,
                score: roundNum(item.candidate.score),
                note: item.decision?.note,
            }));

        if (selected.length > 0) {
            selectedByWrapper.push({
                domId: wrapper.domId,
                className: wrapper.className,
                tableDescendantCount: wrapper.tableDescendantCount,
                selected,
            });
            continue;
        }

        const ranked = [...relevant]
            .map((candidate) => ({
                candidate,
                decision: aggregate.decisionByKey.get(toCandidateKey(candidate)),
            }))
            .sort((left, right) => {
                const leftReason = left.decision?.reason || 'unknown';
                const rightReason = right.decision?.reason || 'unknown';
                const leftPriority = DROP_REASON_PRIORITY[leftReason] ?? -1;
                const rightPriority = DROP_REASON_PRIORITY[rightReason] ?? -1;
                if (rightPriority !== leftPriority) {return rightPriority - leftPriority;}
                return compareCandidate(left.candidate, right.candidate);
            });
        const top = ranked[0];
        const selectedAncestor = tableCandidates
            .filter((candidate) => {
                const decision = aggregate.decisionByKey.get(toCandidateKey(candidate));
                if (!decision?.selected) {return false;}
                return isDescendantOrSelf(candidate.nodeId, wrapper.domId, index);
            })
            .sort(compareCandidate)[0];

        if (!top) {
            const reason = selectedAncestor ? 'not_minimal_selected_ancestor_table' : 'no_table_candidate_under_wrapper';
            pushMissReason(missReasonCount, reason);
            droppedByWrapper.push({
                domId: wrapper.domId,
                className: wrapper.className,
                tableDescendantCount: wrapper.tableDescendantCount,
                reason,
                selectedAncestorTableKey: selectedAncestor ? toCandidateKey(selectedAncestor) : undefined,
                selectedAncestorTableNodeId: selectedAncestor?.nodeId,
            });
            continue;
        }

        const decisionReason = top.decision?.reason || 'unknown';
        const reason = `drop_${decisionReason}`;
        pushMissReason(missReasonCount, reason);
        const blockedBy = top.decision?.blockedByKey ? aggregate.candidateByKey.get(top.decision.blockedByKey) : undefined;
        droppedByWrapper.push({
            domId: wrapper.domId,
            className: wrapper.className,
            tableDescendantCount: wrapper.tableDescendantCount,
            reason,
            candidateKey: toCandidateKey(top.candidate),
            candidateNodeId: top.candidate.nodeId,
            candidateSource: top.candidate.source,
            candidateScore: roundNum(top.candidate.score),
            blockedByKey: top.decision?.blockedByKey,
            blockedByNodeId: blockedBy?.nodeId,
            note: top.decision?.note,
            selectedAncestorTableKey: selectedAncestor ? toCandidateKey(selectedAncestor) : undefined,
            selectedAncestorTableNodeId: selectedAncestor?.nodeId,
        });
    }

    const tableEntities = Object.values(snapshot.entityIndex.entities).filter(
        (entity) => entity.type === 'region' && entity.kind === 'table',
    );

    return {
        meta: {
            url: input.url,
            capturedAt: new Date().toISOString(),
        },
        summary: {
            wrapperCount: wrappers.length,
            selectedWrapperCount: selectedByWrapper.length,
            missedWrapperCount: wrappers.length - selectedByWrapper.length,
            missReasonCount,
            totalTableCandidates: tableCandidates.length,
            selectedTableCandidates: tableCandidates.filter((candidate) => aggregate.decisionByKey.get(toCandidateKey(candidate))?.selected)
                .length,
            tableEntityCount: tableEntities.length,
            tableDecisionReasonCount,
        },
        selectedByWrapper,
        droppedByWrapper,
    };
};

const buildSelectionDiagnostics = (raw: RawData): CandidateAggregate => {
    const tree = buildSelectionTree(raw);
    const candidateByKey = new Map<string, StructureCandidate>();
    const decisionByKey = new Map<string, CandidateDecision>();

    for (const layer of tree.children) {
        const regions = detectRegions(layer);
        for (const region of regions) {
            const detected = detectStructureCandidates(region);
            const debug = selectStructureCandidatesWithDebug(region, detected.candidates);
            for (const candidate of detected.candidates) {
                candidateByKey.set(toCandidateKey(candidate), candidate);
            }
            for (const decision of debug.decisions) {
                decisionByKey.set(decision.key, decision);
            }
        }
    }

    return {
        candidateByKey,
        decisionByKey,
    };
};

const buildSelectionTree = (raw: RawData): UnifiedNode => {
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);
    const layeredGraph = buildSpatialLayers(graph);
    const root: UnifiedNode = {
        id: 'virtual-root',
        role: 'root',
        children: [],
    };

    const [mainBody, ...overlays] = layeredGraph.root.children;
    if (mainBody) {
        root.children.push(mainBody);
    } else {
        root.children.push(layeredGraph.root);
    }
    for (const overlay of overlays) {
        if (isNoiseLayer(overlay)) {continue;}
        root.children.push(overlay);
    }

    root.children = root.children.filter((layer) => !isNonPerceivableLayer(layer));
    return root;
};

const collectTableWrappers = (domTree: unknown): TableWrapperTruth[] => {
    const root = asDomNode(domTree);
    if (!root) {return [];}
    const wrappers: TableWrapperTruth[] = [];

    const visit = (node: DomNodeLike) => {
        const className = normalizeText(node.attrs?.class);
        const isTableWrapper = hasClassToken(className, 'ant-table-wrapper');
        if (isTableWrapper && node.id) {
            wrappers.push({
                domId: node.id,
                backendDomId: normalizeText(node.attrs?.backendDOMNodeId),
                className,
                tableDescendantCount: countDescendantTag(node, 'table'),
            });
        }
        for (const child of node.children || []) {
            visit(child);
        }
    };

    visit(root);
    return wrappers;
};

const countDescendantTag = (node: DomNodeLike, tag: string): number => {
    let count = 0;
    const visit = (current: DomNodeLike) => {
        if (normalizeLower(current.tag) === tag) {
            count += 1;
        }
        for (const child of current.children || []) {
            visit(child);
        }
    };
    for (const child of node.children || []) {
        visit(child);
    }
    return count;
};

const indexTree = (root: UnifiedNode): TreeIndex => {
    const nodeById = new Map<string, UnifiedNode>();
    const enterById = new Map<string, number>();
    const exitById = new Map<string, number>();
    let clock = 0;

    const visit = (node: UnifiedNode) => {
        nodeById.set(node.id, node);
        enterById.set(node.id, clock);
        clock += 1;
        for (const child of node.children) {
            visit(child);
        }
        exitById.set(node.id, clock);
        clock += 1;
    };

    visit(root);
    return {
        nodeById,
        enterById,
        exitById,
    };
};

const isDescendantOrSelf = (ancestorId: string, nodeId: string, index: TreeIndex): boolean => {
    if (ancestorId === nodeId) {return true;}
    const ancestorEnter = index.enterById.get(ancestorId);
    const ancestorExit = index.exitById.get(ancestorId);
    const nodeEnter = index.enterById.get(nodeId);
    const nodeExit = index.exitById.get(nodeId);
    if (ancestorEnter === undefined || ancestorExit === undefined || nodeEnter === undefined || nodeExit === undefined) {
        return false;
    }
    return ancestorEnter < nodeEnter && ancestorExit > nodeExit;
};

const compareCandidate = (left: StructureCandidate, right: StructureCandidate): number => {
    if (right.score !== left.score) {return right.score - left.score;}
    if (right.features.confidence !== left.features.confidence) {return right.features.confidence - left.features.confidence;}
    if (right.depth !== left.depth) {return right.depth - left.depth;}
    return left.nodeId.localeCompare(right.nodeId);
};

const toCandidateKey = (candidate: StructureCandidate): string => {
    return `${candidate.source}:${candidate.kind}:${candidate.nodeId}`;
};

const isNonPerceivableLayer = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName') || '');
    if (NON_PERCEIVABLE_LAYER_ROLES.has(role)) {return true;}
    if (NON_PERCEIVABLE_LAYER_TAGS.has(tag)) {return true;}
    return false;
};

const parseArgs = (argv: string[]): CliOptions => {
    const options: CliOptions = {
        url: DEFAULT_URL,
        timeoutMs: 45_000,
        headless: true,
        outFile: path.join(os.tmpdir(), 'rpa-ant-table-acceptance.json'),
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--url') {
            options.url = argv[i + 1] || options.url;
            i += 1;
            continue;
        }
        if (arg === '--timeout') {
            const next = Number(argv[i + 1]);
            if (Number.isFinite(next) && next > 0) {
                options.timeoutMs = next;
            }
            i += 1;
            continue;
        }
        if (arg === '--headed') {
            options.headless = false;
            continue;
        }
        if (arg === '--out') {
            options.outFile = argv[i + 1] || options.outFile;
            i += 1;
            continue;
        }
    }

    return options;
};

const asDomNode = (value: unknown): DomNodeLike | null => {
    if (!value || typeof value !== 'object') {return null;}
    return value as DomNodeLike;
};

const hasClassToken = (className: string | undefined, token: string): boolean => {
    if (!className) {return false;}
    return className
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .includes(token);
};

const pushMissReason = (counter: Record<string, number>, reason: string) => {
    counter[reason] = (counter[reason] || 0) + 1;
};

const roundNum = (value: number): number => {
    return Number(value.toFixed(4));
};

const normalizeText = (value: string | undefined): string | undefined => {
    const next = (value || '').replace(/\s+/g, ' ').trim();
    return next.length > 0 ? next : undefined;
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const NON_PERCEIVABLE_LAYER_ROLES = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);
const NON_PERCEIVABLE_LAYER_TAGS = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
