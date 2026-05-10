import type { ControlCollector, ControlCollectContext, ControlRegistry } from '../snapshot/control/types';
import type { BaseControlComponent } from '../snapshot/control/types';
import type { UnifiedNode } from '../snapshot/core/types';
import { registerControlCollector } from '../snapshot/control/registry';
import { buildDomIdToNodeIdMap } from '../snapshot/control/collect';

export const registerSelectOptionControls = (registry: ControlRegistry): void => {
    registerControlCollector(registry, collectNativeSelect);
    registerControlCollector(registry, collectRadioGroup);
    registerControlCollector(registry, collectCheckboxGroup);
    registerControlCollector(registry, collectCustomSelect);
};

const OWNER = 'browser.select_option';
const CAPABILITIES = ['select_option'];
const SOURCE = 'auto';

type OptionEntry = {
    value: string;
    label: string;
    selected: boolean;
    nodeId: string;
};

type ParentIdMap = Record<string, string | undefined>;

const collectNativeSelect: ControlCollector = (ctx) => {
    const components: BaseControlComponent[] = [];
    walk(ctx.root, (node) => {
        const tag = readAttrLower(ctx, node, 'tag');
        if (tag !== 'select') {return;}

        const options = collectSelectOptions(ctx, node);
        components.push({
            id: node.id,
            kind: 'native_select',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: node.id,
            controlNodeId: node.id,
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: false,
                multiple: readAttrLower(ctx, node, 'multiple') === 'true',
                disabled: readAttrLower(ctx, node, 'disabled') === 'true',
                readonly: readAttrLower(ctx, node, 'readonly') === 'true',
                focused: readAttrLower(ctx, node, 'focused') === 'true',
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    });
    return components;
};

const collectSelectOptions = (ctx: ControlCollectContext, selectNode: UnifiedNode): OptionEntry[] => {
    const options: OptionEntry[] = [];
    for (const child of selectNode.children) {
        const tag = readAttrLower(ctx, child, 'tag');
        if (tag !== 'option') {continue;}
        const label = readNodeText(ctx, child);
        const value = readAttrRaw(ctx, child, 'value') || label;
        const selected = readAttrLower(ctx, child, 'selected') === 'true';
        options.push({ value, label, selected, nodeId: child.id });
    }
    return options;
};

const collectRadioGroup: ControlCollector = (ctx) => {
    const parentIdMap = buildParentIdMap(ctx.root);
    const radioNodes = collectInputsByType(ctx, 'radio');
    const partitioned = partitionByContainer(radioNodes, parentIdMap, ctx);

    const components: BaseControlComponent[] = [];
    for (const regionNodes of partitioned.values()) {
        const groups = groupBy(regionNodes, (node) => readAttrRaw(ctx, node, 'name') || node.id);
        for (const [, members] of groups) {
            if (members.length < 2) {continue;}
            const parentId = findCommonParentId(members, parentIdMap);
            const options = members.map((node) => ({
                value: readAttrRaw(ctx, node, 'value') || readNodeText(ctx, node),
                label: readNodeText(ctx, node),
                selected: readAttrLower(ctx, node, 'checked') === 'true',
                nodeId: node.id,
            }));
            components.push({
                id: `radio_group_${members[0].id}`,
                kind: 'radio_group',
                owner: OWNER,
                capabilities: CAPABILITIES,
                source: SOURCE,
                confidence: 1,
                rootNodeId: parentId,
                optionNodeIds: options.map((opt) => opt.nodeId),
                state: {
                    expanded: false,
                    multiple: false,
                    disabled: members.every((n) => readAttrLower(ctx, n, 'disabled') === 'true'),
                    readonly: false,
                    focused: false,
                },
                data: {
                    options,
                    selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                    selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                    optionMatchHints: options.map((opt) => opt.label),
                },
            });
        }
    }
    return components;
};

const partitionByContainer = (
    nodes: UnifiedNode[],
    parentIdMap: ParentIdMap,
    ctx: ControlCollectContext,
): Map<string, UnifiedNode[]> => {
    const partitions = new Map<string, UnifiedNode[]>();
    for (const node of nodes) {
        const containerId = findNearestContainerId(node, parentIdMap, ctx);
        const bucket = partitions.get(containerId) || [];
        bucket.push(node);
        partitions.set(containerId, bucket);
    }
    return partitions;
};

const RADIO_CONTAINER_ROLES = new Set(['radiogroup', 'group', 'form']);
const RADIO_CONTAINER_CLASS_SIGNALS = ['ant-radio-group', 'radio-group', 'form-item', 'ant-form-item'];

const findNearestContainerId = (
    node: UnifiedNode,
    parentIdMap: ParentIdMap,
    ctx: ControlCollectContext,
): string => {
    let currentId: string | undefined = parentIdMap[node.id];
    while (currentId) {
        const parent = ctx.nodeIndex[currentId];
        if (parent) {
            if (RADIO_CONTAINER_ROLES.has(parent.role)) {return currentId;}
            const cls = readAttrLower(ctx, parent, 'class') || '';
            for (const signal of RADIO_CONTAINER_CLASS_SIGNALS) {
                if (hasClassToken(cls, signal)) {return currentId;}
            }
        }
        currentId = parentIdMap[currentId];
    }
    return parentIdMap[node.id] || node.id;
};

const collectCheckboxGroup: ControlCollector = (ctx) => {
    const parentIdMap = buildParentIdMap(ctx.root);
    const checkboxNodes = collectInputsByType(ctx, 'checkbox');

    // First, try to find explicit group containers (role=group, ant-checkbox-group class, etc.)
    const explicitGroups = new Map<string, UnifiedNode[]>();
    const unmatched: UnifiedNode[] = [];

    for (const node of checkboxNodes) {
        const containerId = findNearestExplicitCheckboxGroup(node, parentIdMap, ctx);
        if (containerId) {
            const bucket = explicitGroups.get(containerId) || [];
            bucket.push(node);
            explicitGroups.set(containerId, bucket);
        } else {
            unmatched.push(node);
        }
    }

    // Fallback: group unmatched by nearest safe container
    const fallbackGroups = new Map<string, UnifiedNode[]>();
    for (const node of unmatched) {
        const containerId = findNearestSafeContainer(node, parentIdMap, ctx);
        const bucket = fallbackGroups.get(containerId) || [];
        bucket.push(node);
        fallbackGroups.set(containerId, bucket);
    }

    const components: BaseControlComponent[] = [];
    const allGroups = new Map(explicitGroups);
    for (const [key, members] of fallbackGroups) {
        if (!allGroups.has(key)) {
            allGroups.set(key, members);
        } else {
            const existing = allGroups.get(key)!;
            for (const m of members) {
                existing.push(m);
            }
        }
    }

    for (const [parentId, members] of allGroups) {
        if (members.length < 2) {continue;}
        const options = members.map((node) => ({
            value: readAttrRaw(ctx, node, 'value') || readNodeText(ctx, node),
            label: readNodeText(ctx, node),
            selected: readAttrLower(ctx, node, 'checked') === 'true',
            nodeId: node.id,
        }));
        components.push({
            id: `checkbox_group_${members[0].id}`,
            kind: 'checkbox_group',
            owner: OWNER,
            capabilities: CAPABILITIES,
            source: SOURCE,
            confidence: 1,
            rootNodeId: parentId,
            optionNodeIds: options.map((opt) => opt.nodeId),
            state: {
                expanded: false,
                multiple: true,
                disabled: members.every((n) => readAttrLower(ctx, n, 'disabled') === 'true'),
                readonly: false,
                focused: false,
            },
            data: {
                options,
                selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
                selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
                optionMatchHints: options.map((opt) => opt.label),
            },
        });
    }
    return components;
};

const CHECKBOX_SAFE_CONTAINER_ROLES = new Set(['form', 'group']);
const CHECKBOX_SAFE_CONTAINER_CLASS_SIGNALS = ['form-item', 'ant-form-item'];

const findNearestSafeContainer = (
    node: UnifiedNode,
    parentIdMap: ParentIdMap,
    ctx: ControlCollectContext,
): string => {
    let currentId: string | undefined = parentIdMap[node.id];
    while (currentId) {
        const parent = ctx.nodeIndex[currentId];
        if (parent) {
            if (CHECKBOX_SAFE_CONTAINER_ROLES.has(parent.role)) {return currentId;}
            const cls = readAttrLower(ctx, parent, 'class') || '';
            for (const signal of CHECKBOX_SAFE_CONTAINER_CLASS_SIGNALS) {
                if (hasClassToken(cls, signal)) {return currentId;}
            }
        }
        currentId = parentIdMap[currentId];
    }
    return parentIdMap[node.id] || node.id;
};

const CHECKBOX_GROUP_CLASS_SIGNALS = ['ant-checkbox-group', 'checkbox-group'];

const findNearestExplicitCheckboxGroup = (
    node: UnifiedNode,
    parentIdMap: ParentIdMap,
    ctx: ControlCollectContext,
): string | undefined => {
    let currentId: string | undefined = parentIdMap[node.id];
    while (currentId) {
        const parent = ctx.nodeIndex[currentId];
        if (parent) {
            if (parent.role === 'group') {return currentId;}
            const cls = readAttrLower(ctx, parent, 'class') || '';
            for (const signal of CHECKBOX_GROUP_CLASS_SIGNALS) {
                if (hasClassToken(cls, signal)) {return currentId;}
            }
        }
        currentId = parentIdMap[currentId];
    }
    return undefined;
};

const ANT_SELECT_ROOT_CLASS = 'ant-select';
const ANT_SELECT_TRIGGER_CLASS = 'ant-select-selector';
const ANT_SELECT_FORBIDDEN_ROOT_CLASSES = new Set([
    'ant-select-dropdown',
    'ant-select-item-option',
    'ant-select-dropdown-menu-item',
]);

const ANT_SELECT_OPTION_CLASS_SIGNALS = [
    'ant-select-item-option',
    'ant-select-dropdown-menu-item',
];

const ANT_SELECT_POPUP_CLASS_SIGNALS = [
    'ant-select-dropdown',
];

const collectCustomSelect: ControlCollector = (ctx) => {
    const domIdMap = buildDomIdToNodeIdMap(ctx.attrIndex);
    const parentIdMap = buildParentIdMap(ctx.root);
    const comboboxRootIds = new Set<string>();
    const consumedPopupIds = new Set<string>();
    const components: BaseControlComponent[] = [];

    const pushComponent = (
        rootNode: UnifiedNode,
        popupNodeId: string,
        options: OptionEntry[],
        triggerNodeId?: string,
    ) => {
        consumedPopupIds.add(popupNodeId);
        components.push(buildCustomSelectComponent(rootNode, popupNodeId, options, ctx, triggerNodeId));
    };

    walk(ctx.root, (node) => {
        // Primary path: role=combobox
        if (node.role === 'combobox') {
            const popupNodeId = resolvePopupNodeId(node, ctx, domIdMap);
            if (!popupNodeId) {return;}
            if (consumedPopupIds.has(popupNodeId)) {return;}
            const options = collectPopupOptions(ctx, popupNodeId);
            if (options.length === 0) {return;}
            comboboxRootIds.add(node.id);
            pushComponent(node, popupNodeId, options);
            return;
        }

        // Auxiliary path: Ant Select class signals
        const cls = readAttrLower(ctx, node, 'class') || '';

        // Forbidden root classes must never produce custom_select
        if (ANT_SELECT_FORBIDDEN_ROOT_CLASSES.has(cls.split(/\s+/).find((t) => ANT_SELECT_FORBIDDEN_ROOT_CLASSES.has(t)) || '')) {return;}

        const hasAntSelectRoot = hasClassToken(cls, ANT_SELECT_ROOT_CLASS);
        const hasAntSelectTrigger = hasClassToken(cls, ANT_SELECT_TRIGGER_CLASS);

        if (!hasAntSelectRoot && !hasAntSelectTrigger) {return;}

        // ant-select-selector: only act as root when no ant-select ancestor exists
        if (hasAntSelectTrigger && !hasAntSelectRoot) {
            if (findAncestorByClass(node.id, ANT_SELECT_ROOT_CLASS, parentIdMap, ctx)) {return;}
        }

        // Determine root node and trigger
        let rootNode = node;
        let triggerNodeId: string | undefined;

        if (hasAntSelectRoot) {
            rootNode = node;
            triggerNodeId = hasAntSelectTrigger ? node.id
                : findDescendantByClass(node, ANT_SELECT_TRIGGER_CLASS, ctx);
        }

        // Don't duplicate a combobox that was already handled
        if (comboboxRootIds.has(rootNode.id)) {return;}

        const popupNodeId = findAntSelectPopup(node, domIdMap, ctx);
        if (!popupNodeId) {return;}
        if (consumedPopupIds.has(popupNodeId)) {return;}
        const options = collectAntSelectOptions(ctx, popupNodeId);
        if (options.length === 0) {return;}
        pushComponent(rootNode, popupNodeId, options, triggerNodeId);
    });
    return components;
};

const buildCustomSelectComponent = (
    node: UnifiedNode,
    popupNodeId: string,
    options: OptionEntry[],
    ctx: ControlCollectContext,
    triggerNodeId?: string,
): BaseControlComponent => ({
    id: node.id,
    kind: 'custom_select',
    owner: OWNER,
    capabilities: CAPABILITIES,
    source: SOURCE,
    confidence: 1,
    rootNodeId: node.id,
    controlNodeId: node.id,
    triggerNodeId,
    popupNodeId,
    optionNodeIds: options.map((opt) => opt.nodeId),
    state: {
        expanded: readAttrLower(ctx, node, 'aria-expanded') === 'true',
        multiple: readAttrLower(ctx, node, 'aria-multiselectable') === 'true',
        disabled: readAttrLower(ctx, node, 'disabled') === 'true',
        readonly: readAttrLower(ctx, node, 'readonly') === 'true',
        focused: readAttrLower(ctx, node, 'focused') === 'true',
    },
    data: {
        options,
        selectedValues: options.filter((opt) => opt.selected).map((opt) => opt.value),
        selectedLabels: options.filter((opt) => opt.selected).map((opt) => opt.label),
        optionMatchHints: options.map((opt) => opt.label),
    },
});

const resolvePopupNodeId = (
    comboboxNode: UnifiedNode,
    ctx: ControlCollectContext,
    domIdMap: Record<string, string>,
): string | undefined => {
    const controlsDomId = normalizeText(readAttrRaw(ctx, comboboxNode, 'aria-controls'));
    if (controlsDomId) {
        const nodeId = domIdMap[controlsDomId];
        if (nodeId && ctx.nodeIndex[nodeId]) {return nodeId;}
    }

    const ownsDomId = normalizeText(readAttrRaw(ctx, comboboxNode, 'aria-owns'));
    if (ownsDomId) {
        const nodeId = domIdMap[ownsDomId];
        if (nodeId && ctx.nodeIndex[nodeId]) {return nodeId;}
    }

    return undefined;
};

const findAntSelectPopup = (
    triggerNode: UnifiedNode,
    domIdMap: Record<string, string>,
    ctx: ControlCollectContext,
): string | undefined => {
    const controlsDomId = normalizeText(readAttrRaw(ctx, triggerNode, 'aria-controls'));
    if (controlsDomId) {
        const nodeId = domIdMap[controlsDomId];
        if (nodeId && ctx.nodeIndex[nodeId]) {return nodeId;}
    }

    for (const [nodeId, node] of Object.entries(ctx.nodeIndex)) {
        const cls = readAttrLower(ctx, node, 'class') || '';
        if (ANT_SELECT_POPUP_CLASS_SIGNALS.some((signal) => hasClassToken(cls, signal))) {
            if (node.role === 'listbox' || node.role === 'menu') {
                return nodeId;
            }
        }
    }

    return undefined;
};

const findAncestorByClass = (
    nodeId: string,
    classToken: string,
    parentIdMap: ParentIdMap,
    ctx: ControlCollectContext,
): string | undefined => {
    let currentId: string | undefined = parentIdMap[nodeId];
    while (currentId) {
        const parent = ctx.nodeIndex[currentId];
        if (parent) {
            const cls = readAttrLower(ctx, parent, 'class') || '';
            if (hasClassToken(cls, classToken)) {return currentId;}
        }
        currentId = parentIdMap[currentId];
    }
    return undefined;
};

const findDescendantByClass = (
    root: UnifiedNode,
    classToken: string,
    ctx: ControlCollectContext,
): string | undefined => {
    const stack = [...root.children];
    while (stack.length > 0) {
        const child = stack.pop()!;
        const cls = readAttrLower(ctx, child, 'class') || '';
        if (hasClassToken(cls, classToken)) {return child.id;}
        for (let i = child.children.length - 1; i >= 0; i -= 1) {
            stack.push(child.children[i]);
        }
    }
    return undefined;
};

const collectPopupOptions = (ctx: ControlCollectContext, popupNodeId: string): OptionEntry[] => {
    const options: OptionEntry[] = [];
    const visited = new Set<string>();
    const queue = [popupNodeId];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) {continue;}
        visited.add(currentId);

        const node = ctx.nodeIndex[currentId];
        if (!node) {continue;}

        if (node.role === 'option') {
            const label = readNodeText(ctx, node);
            const value = readAttrRaw(ctx, node, 'value') || readAttrRaw(ctx, node, 'data-value') || label;
            const selected = readAttrLower(ctx, node, 'aria-selected') === 'true'
                || readAttrLower(ctx, node, 'aria-checked') === 'true';
            options.push({ value, label, selected, nodeId: currentId });
        }

        for (const child of node.children) {
            if (!visited.has(child.id)) {
                queue.push(child.id);
            }
        }
    }
    return options;
};

const collectAntSelectOptions = (ctx: ControlCollectContext, popupNodeId: string): OptionEntry[] => {
    const options: OptionEntry[] = [];
    const visited = new Set<string>();
    const queue = [popupNodeId];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) {continue;}
        visited.add(currentId);

        const node = ctx.nodeIndex[currentId];
        if (!node) {continue;}

        const cls = readAttrLower(ctx, node, 'class') || '';
        const isOption = node.role === 'option'
            || ANT_SELECT_OPTION_CLASS_SIGNALS.some((signal) => hasClassToken(cls, signal));

        if (isOption) {
            const label = readNodeText(ctx, node);
            const value = readAttrRaw(ctx, node, 'value') || readAttrRaw(ctx, node, 'data-value') || label;
            const selected = readAttrLower(ctx, node, 'aria-selected') === 'true'
                || readAttrLower(ctx, node, 'aria-checked') === 'true'
                || hasClassToken(cls, 'ant-select-item-option-selected');
            options.push({ value, label, selected, nodeId: currentId });
        }

        for (const child of node.children) {
            if (!visited.has(child.id)) {
                queue.push(child.id);
            }
        }
    }
    return options;
};

const collectInputsByType = (ctx: ControlCollectContext, inputType: string): UnifiedNode[] => {
    const nodes: UnifiedNode[] = [];
    walk(ctx.root, (node) => {
        const tag = readAttrLower(ctx, node, 'tag');
        const type = readAttrLower(ctx, node, 'type');
        if (tag === 'input' && type === inputType) {
            nodes.push(node);
        }
    });
    return nodes;
};

const buildParentIdMap = (root: UnifiedNode): ParentIdMap => {
    const map: ParentIdMap = {};
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const child of current.children) {
            map[child.id] = current.id;
            stack.push(child);
        }
    }
    return map;
};

const findCommonParentId = (nodes: UnifiedNode[], parentIdMap: ParentIdMap): string => {
    if (nodes.length === 0) {return '';}
    if (nodes.length === 1) {return nodes[0].id;}

    const ancestorPaths = nodes.map((node) => {
        const path: string[] = [node.id];
        let currentId: string | undefined = parentIdMap[node.id];
        while (currentId) {
            path.unshift(currentId);
            currentId = parentIdMap[currentId];
        }
        return path;
    });

    let commonId = '';
    const minLen = Math.min(...ancestorPaths.map((p) => p.length));
    for (let i = 0; i < minLen; i += 1) {
        const id = ancestorPaths[0][i];
        if (ancestorPaths.every((p) => p[i] === id)) {
            commonId = id;
        } else {
            break;
        }
    }
    return commonId;
};

const readAttrRaw = (ctx: ControlCollectContext, node: UnifiedNode, key: string): string =>
    (ctx.attrIndex[node.id]?.[key] || '').trim();

const readAttrLower = (ctx: ControlCollectContext, node: UnifiedNode, key: string): string =>
    readAttrRaw(ctx, node, key).toLowerCase();

const walk = (root: UnifiedNode, visitor: (node: UnifiedNode) => void): void => {
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        visitor(node);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push(node.children[i]);
        }
    }
};

const groupBy = <T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const key = keyFn(item);
        const bucket = map.get(key) || [];
        bucket.push(item);
        map.set(key, bucket);
    }
    return map;
};

const readNodeText = (ctx: ControlCollectContext, node: UnifiedNode): string => {
    if (node.name) {return node.name;}
    if (typeof node.content === 'string') {return node.content;}
    if (node.content?.ref) {
        const text = ctx.contentStore[node.content.ref];
        if (text) {return text;}
    }
    for (const child of node.children) {
        if (typeof child.content === 'string') {
            return child.content;
        }
        if (child.content?.ref) {
            const text = ctx.contentStore[child.content.ref];
            if (text) {return text;}
        }
    }
    return '';
};

const hasClassToken = (classValue: string, token: string): boolean => {
    if (!classValue) {return false;}
    return classValue.split(/\s+/).includes(token);
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
};
