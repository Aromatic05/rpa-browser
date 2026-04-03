import type { Page } from 'playwright';

export type DomTreeNode = {
    id: string;
    tag: string;
    text?: string;
    children: DomTreeNode[];
    bbox?: { x: number; y: number; width: number; height: number };
    backendDOMNodeId?: string;
    attrs?: Record<string, string>;
};

type DomSnapshotCaptureResult = {
    documents?: DocumentSnapshot[];
    strings?: string[];
};

type DocumentSnapshot = {
    nodes?: SnapshotNodes;
    layout?: SnapshotLayout;
};

type SnapshotNodes = {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    nodeValue?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
};

type SnapshotLayout = {
    nodeIndex?: number[];
    bounds?: Array<number[] | undefined>;
};

type NodeView = {
    strings: string[];
    parentIndex: number[];
    nodeType: number[];
    nodeName: number[];
    nodeValue: number[];
    backendNodeId: number[];
    attributes: number[][];
    childrenByParent: Map<number, number[]>;
    bboxByNodeIndex: Map<number, DomTreeNode['bbox']>;
};

const NODE_TYPE = {
    ELEMENT: 1,
    TEXT: 3,
    CDATA: 4,
    DOCUMENT: 9,
} as const;

export const getDomTree = async (page: Page): Promise<DomTreeNode | null> => {
    // 单源方案：DOM 树全部来自同一次 CDP DOMSnapshot，避免跨源路径对齐漂移。
    const cdp = await page.context().newCDPSession(page);
    try {
        const raw = (await cdp.send('DOMSnapshot.captureSnapshot', {
            computedStyles: [],
            includeDOMRects: true,
            includePaintOrder: false,
        })) as DomSnapshotCaptureResult;

        const built = buildDomTreeFromSnapshot(raw);
        return built;
    } catch (error) {
        if (process.env.RPA_SNAPSHOT_DEBUG === '1' || process.env.RPA_SNAPSHOT_DEBUG === 'true') {
            console.warn('[snapshot][dom] getDomTree(DOMSnapshot) failed', error);
        }
        return null;
    } finally {
        await cdp.detach().catch(() => undefined);
    }
};

const buildDomTreeFromSnapshot = (raw: DomSnapshotCaptureResult): DomTreeNode | null => {
    const document = Array.isArray(raw.documents) ? raw.documents[0] : undefined;
    const strings = Array.isArray(raw.strings) ? raw.strings : [];
    if (!document?.nodes) return null;

    const view = createNodeView(document, strings);
    if (!view) return null;

    const rootIndex = findRootElementIndex(view);
    if (rootIndex < 0) return null;
    return buildElementNode(view, rootIndex, 'n0');
};

const createNodeView = (document: DocumentSnapshot, strings: string[]): NodeView | null => {
    const nodes = document.nodes;
    if (!nodes) return null;

    const parentIndex = Array.isArray(nodes.parentIndex) ? nodes.parentIndex : [];
    const nodeType = Array.isArray(nodes.nodeType) ? nodes.nodeType : [];
    const nodeName = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
    const nodeValue = Array.isArray(nodes.nodeValue) ? nodes.nodeValue : [];
    const backendNodeId = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
    const attributes = Array.isArray(nodes.attributes) ? nodes.attributes : [];

    const count = nodeType.length;
    if (count === 0) return null;

    const childrenByParent = new Map<number, number[]>();
    for (let index = 0; index < count; index += 1) {
        const parent = parentIndex[index];
        if (typeof parent !== 'number' || parent < 0) continue;
        const bucket = childrenByParent.get(parent) || [];
        bucket.push(index);
        childrenByParent.set(parent, bucket);
    }

    const bboxByNodeIndex = collectBoundingBoxes(document.layout);

    return {
        strings,
        parentIndex,
        nodeType,
        nodeName,
        nodeValue,
        backendNodeId,
        attributes,
        childrenByParent,
        bboxByNodeIndex,
    };
};

const findRootElementIndex = (view: NodeView): number => {
    const total = view.nodeType.length;

    // 优先找 <html> 根节点。
    for (let index = 0; index < total; index += 1) {
        if (!isElementNode(view, index)) continue;
        if (readTagName(view, index) !== 'html') continue;
        return index;
    }

    // 退化：找 document 的第一个 element 子节点。
    for (let index = 0; index < total; index += 1) {
        if (!isElementNode(view, index)) continue;
        const parent = view.parentIndex[index];
        if (parent < 0) return index;
        if (view.nodeType[parent] === NODE_TYPE.DOCUMENT) return index;
    }

    // 最后兜底：第一个 element。
    for (let index = 0; index < total; index += 1) {
        if (isElementNode(view, index)) return index;
    }
    return -1;
};

const buildElementNode = (view: NodeView, index: number, id: string): DomTreeNode | null => {
    if (!isElementNode(view, index)) return null;

    const tag = readTagName(view, index);
    if (!tag || BLACKLIST_TAGS.has(tag)) return null;

    const childIndexes = view.childrenByParent.get(index) || [];
    const children: DomTreeNode[] = [];
    let childIndex = 0;
    for (const child of childIndexes) {
        if (!isElementNode(view, child)) continue;
        const childNode = buildElementNode(view, child, `${id}.${childIndex}`);
        childIndex += 1;
        if (childNode) children.push(childNode);
    }

    const backendNodeId = view.backendNodeId[index];
    const backendDOMNodeId = typeof backendNodeId === 'number' && backendNodeId > 0 ? String(backendNodeId) : undefined;
    const attrs = decodeWhitelistedAttrs(view, index, backendDOMNodeId);

    return {
        id,
        tag,
        text: readOwnText(view, index),
        children,
        bbox: view.bboxByNodeIndex.get(index),
        backendDOMNodeId,
        attrs,
    };
};

const decodeWhitelistedAttrs = (
    view: NodeView,
    index: number,
    backendDOMNodeId: string | undefined,
): Record<string, string> | undefined => {
    const raw = view.attributes[index];
    const attrs: Record<string, string> = {};
    if (Array.isArray(raw)) {
        for (let cursor = 0; cursor + 1 < raw.length; cursor += 2) {
            const rawNameIndex = raw[cursor];
            const rawValueIndex = raw[cursor + 1];
            const name = readString(view, rawNameIndex).toLowerCase();
            if (!name || !ATTR_WHITELIST.has(name)) continue;
            attrs[name] = readString(view, rawValueIndex);
        }
    }

    if (backendDOMNodeId) {
        attrs.backendDOMNodeId = backendDOMNodeId;
    }
    return Object.keys(attrs).length > 0 ? attrs : undefined;
};

const readOwnText = (view: NodeView, index: number): string | undefined => {
    const childIndexes = view.childrenByParent.get(index) || [];
    const chunks: string[] = [];
    for (const child of childIndexes) {
        const type = view.nodeType[child];
        if (type !== NODE_TYPE.TEXT && type !== NODE_TYPE.CDATA) continue;
        const value = readNodeValue(view, child);
        if (value) chunks.push(value);
    }
    const normalized = normalizeText(chunks.join(' '));
    return normalized || undefined;
};

const collectBoundingBoxes = (layout: SnapshotLayout | undefined): Map<number, DomTreeNode['bbox']> => {
    const map = new Map<number, DomTreeNode['bbox']>();
    if (!layout) return map;

    const nodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
    const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
    const limit = Math.min(nodeIndexes.length, bounds.length);

    for (let i = 0; i < limit; i += 1) {
        const nodeIndex = nodeIndexes[i];
        const rect = bounds[i];
        if (typeof nodeIndex !== 'number' || !Array.isArray(rect) || rect.length < 4) continue;
        const next = toBbox(rect);
        if (!next) continue;

        const previous = map.get(nodeIndex);
        if (!previous) {
            map.set(nodeIndex, next);
            continue;
        }
        map.set(nodeIndex, unionBbox(previous, next));
    }
    return map;
};

const toBbox = (rect: number[]): DomTreeNode['bbox'] | undefined => {
    const [xRaw, yRaw, widthRaw, heightRaw] = rect;
    if ([xRaw, yRaw, widthRaw, heightRaw].some((item) => typeof item !== 'number' || Number.isNaN(item))) {
        return undefined;
    }

    const width = Math.round(widthRaw);
    const height = Math.round(heightRaw);
    if (width <= 0 && height <= 0) return undefined;

    return {
        x: Math.round(xRaw),
        y: Math.round(yRaw),
        width,
        height,
    };
};

const unionBbox = (left: NonNullable<DomTreeNode['bbox']>, right: NonNullable<DomTreeNode['bbox']>): NonNullable<DomTreeNode['bbox']> => {
    const x1 = Math.min(left.x, right.x);
    const y1 = Math.min(left.y, right.y);
    const x2 = Math.max(left.x + left.width, right.x + right.width);
    const y2 = Math.max(left.y + left.height, right.y + right.height);
    return {
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
    };
};

const readTagName = (view: NodeView, index: number): string => {
    return readString(view, view.nodeName[index]).toLowerCase();
};

const readNodeValue = (view: NodeView, index: number): string => {
    return normalizeText(readString(view, view.nodeValue[index])) || '';
};

const readString = (view: NodeView, index: number): string => {
    if (typeof index !== 'number' || index < 0) return '';
    return view.strings[index] || '';
};

const normalizeText = (value: string): string => {
    return value.replace(/\s+/g, ' ').trim();
};

const isElementNode = (view: NodeView, index: number): boolean => {
    return view.nodeType[index] === NODE_TYPE.ELEMENT;
};

const BLACKLIST_TAGS = new Set(['script', 'style']);
const ATTR_WHITELIST = new Set([
    'id',
    'class',
    'name',
    'type',
    'role',
    'aria-label',
    'placeholder',
    'href',
    'value',
]);
