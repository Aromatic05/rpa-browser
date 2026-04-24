type DomNode = {
    tag?: string;
    backendDOMNodeId?: string;
    attrs?: Record<string, string>;
    children?: DomNode[];
};

export const buildBackendDomSelectorMap = (domTree: unknown): Record<string, string> => {
    const root = asDomNode(domTree);
    if (!root) {return {};}

    const result: Record<string, string> = {};

    const walk = (node: DomNode, parentPath: string | undefined, siblings: DomNode[] | undefined) => {
        const tag = normalizeTag(node.tag || node.attrs?.tag || node.attrs?.tagName);
        if (!tag) {
            for (const child of node.children || []) {
                walk(child, parentPath, node.children);
            }
            return;
        }

        const nthOfType = computeNthOfType(node, siblings, tag);
        const currentSegment = `${tag}:nth-of-type(${nthOfType})`;
        const currentPath = parentPath ? `${parentPath} > ${currentSegment}` : currentSegment;

        const backendId = normalizeBackendId(node.backendDOMNodeId || node.attrs?.backendDOMNodeId);
        if (backendId) {
            result[backendId] = currentPath;
        }

        for (const child of node.children || []) {
            walk(child, currentPath, node.children);
        }
    };

    walk(root, undefined, undefined);
    return result;
};

const asDomNode = (value: unknown): DomNode | null => {
    if (!value || typeof value !== 'object') {return null;}
    return value;
};

const normalizeTag = (value: string | undefined): string => {
    const tag = (value || '').trim().toLowerCase();
    return tag && !tag.startsWith('::') ? tag : '';
};

const normalizeBackendId = (value: string | undefined): string => (value || '').trim();

const computeNthOfType = (node: DomNode, siblings: DomNode[] | undefined, tag: string): number => {
    if (!siblings || siblings.length === 0) {return 1;}
    let index = 0;
    for (const sibling of siblings) {
        const siblingTag = normalizeTag(sibling.tag || sibling.attrs?.tag || sibling.attrs?.tagName);
        if (siblingTag !== tag) {continue;}
        index += 1;
        if (sibling === node) {return index;}
    }
    return 1;
};
