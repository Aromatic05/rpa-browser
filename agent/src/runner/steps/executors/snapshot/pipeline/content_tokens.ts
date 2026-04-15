import { getNodeAttrs, getNodeContent, normalizeText, setNodeContent } from '../core/runtime_store';
import type { UnifiedNode } from '../core/types';

const TOKEN_JOINER = '; ';

export const projectInteractionStateContent = (root: UnifiedNode) => {
    walk(root, (node) => {
        const tokens = buildInteractionContentTokens(node);
        if (tokens.length === 0) return;
        const content = joinContentTokens(tokens);
        node.content = content;
        setNodeContent(node, content);
    });
};

export const buildInteractionContentTokens = (node: UnifiedNode): string[] => {
    const attrs = getNodeAttrs(node) || {};
    const role = normalizeRole(node.role);
    const tag = normalizeRole(attrs.tag || attrs.tagName);
    const inputType = normalizeRole(attrs.type);

    if (!isStatefulInteractionNode(role, tag, inputType, attrs)) {
        return [];
    }

    const primary: string[] = [];
    const check: string[] = [];
    const expand: string[] = [];
    const pressed: string[] = [];
    const other: string[] = [];
    const aux: string[] = [];

    if (isTextInputNode(role, tag, inputType)) {
        const value = readAttrValue(attrs, 'value');
        if (value) {
            primary.push(formatKeyValueToken('value', value));
        } else {
            primary.push('empty');
            const placeholder = readAttrValue(attrs, 'placeholder');
            if (placeholder) {
                aux.push(formatKeyValueToken('placeholder', placeholder));
            }
        }
    }

    if (isSelectLikeNode(role, tag)) {
        const selected = resolveSelectedValues(node);
        if (selected.length > 0) {
            primary.push(formatKeyValueToken('selected', selected.join(', ')));
        } else {
            primary.push('empty');
        }
    }

    if (isCheckableNode(role, tag, inputType)) {
        const checkState = resolveCheckedState(attrs);
        if (checkState) {
            check.push('checked');
        } else {
            check.push('unchecked');
        }
    }

    const expanded = resolveBooleanState(attrs, ['aria-expanded', 'expanded']);
    if (expanded !== undefined) {
        expand.push(expanded ? 'expanded' : 'collapsed');
    }

    const pressState = resolveBooleanState(attrs, ['aria-pressed', 'pressed']);
    if (pressState !== undefined) {
        pressed.push(pressState ? 'pressed' : 'unpressed');
    }

    const focused = resolveBooleanState(attrs, ['focused', 'aria-focused']);
    if (focused) {
        other.push('focused');
    }

    const disabled = resolveBooleanState(attrs, ['disabled', 'aria-disabled']);
    if (disabled) {
        other.push('disabled');
    }

    const readonly = resolveBooleanState(attrs, ['readonly', 'aria-readonly']);
    if (readonly) {
        other.push('readonly');
    }

    const invalid = resolveInvalidState(attrs);
    if (invalid) {
        other.push('invalid');
    }

    const ordered = [...primary, ...check, ...expand, ...pressed, ...other, ...aux];
    return dedupeTokens(ordered);
};

export const joinContentTokens = (tokens: string[]): string => {
    return tokens.join(TOKEN_JOINER);
};

export const normalizeContentTokenValue = (value: string): string => {
    const normalized = normalizeText(value) || '';
    if (!normalized) return '';
    return normalized
        .replace(/;/g, ',')
        .replace(/"/g, '\\"');
};

const isStatefulInteractionNode = (
    role: string,
    tag: string,
    inputType: string,
    attrs: Record<string, string>,
): boolean => {
    if (isTextInputNode(role, tag, inputType)) return true;
    if (isCheckableNode(role, tag, inputType)) return true;
    if (isSelectLikeNode(role, tag)) return true;

    if (role === 'button') {
        if (resolveBooleanState(attrs, ['aria-pressed', 'pressed']) !== undefined) return true;
        if (resolveBooleanState(attrs, ['aria-expanded', 'expanded']) !== undefined) return true;
    }

    if (hasAnyAttr(attrs, ['aria-expanded', 'aria-pressed', 'disabled', 'readonly', 'aria-invalid'])) {
        return isLikelyInteractiveNode(role, tag, inputType);
    }

    return false;
};

const isLikelyInteractiveNode = (role: string, tag: string, inputType: string): boolean => {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (inputType) return true;
    return false;
};

const isTextInputNode = (role: string, tag: string, inputType: string): boolean => {
    if (CHECKABLE_INPUT_TYPES.has(inputType)) return false;
    if (role === 'textbox' || role === 'textarea' || role === 'searchbox') return true;
    if (tag === 'textarea') return true;
    if (tag === 'input' && TEXT_INPUT_TYPES.has(inputType || 'text')) return true;
    return false;
};

const isCheckableNode = (role: string, tag: string, inputType: string): boolean => {
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return true;
    if (tag === 'input' && CHECKABLE_INPUT_TYPES.has(inputType)) return true;
    return false;
};

const isSelectLikeNode = (role: string, tag: string): boolean => {
    if (role === 'combobox' || role === 'listbox') return true;
    if (tag === 'select') return true;
    return false;
};

const resolveSelectedValues = (node: UnifiedNode): string[] => {
    const attrs = getNodeAttrs(node) || {};
    const selectedValue = readAttrValue(attrs, 'selected');
    if (selectedValue) {
        return [selectedValue];
    }

    const directValue = readAttrValue(attrs, 'value');
    if (directValue) {
        return [directValue];
    }

    const selected: string[] = [];
    walk(node, (cursor) => {
        if (cursor === node) return;
        const role = normalizeRole(cursor.role);
        const childAttrs = getNodeAttrs(cursor) || {};
        const tag = normalizeRole(childAttrs.tag || childAttrs.tagName);
        if (role !== 'option' && tag !== 'option') return;

        const isSelected = resolveBooleanState(childAttrs, ['aria-selected', 'selected']);
        if (!isSelected) return;

        const label =
            normalizeText(cursor.name) ||
            readAttrValue(childAttrs, 'value') ||
            normalizeText(getNodeContent(cursor)) ||
            (typeof cursor.content === 'string' ? normalizeText(cursor.content) : undefined);
        if (!label) return;
        selected.push(label);
    });

    return [...new Set(selected)];
};

const resolveCheckedState = (attrs: Record<string, string>): boolean => {
    const ariaChecked = readRawAttr(attrs, 'aria-checked');
    if (ariaChecked.found) {
        const normalized = normalizeRole(ariaChecked.value);
        if (normalized === 'mixed') return true;
        const parsed = parseBooleanAttr(ariaChecked.value, ariaChecked.found);
        if (parsed !== undefined) return parsed;
    }

    const checked = readRawAttr(attrs, 'checked');
    const parsedChecked = parseBooleanAttr(checked.value, checked.found);
    if (parsedChecked !== undefined) {
        return parsedChecked;
    }

    const state = normalizeRole(readRawAttr(attrs, 'data-state').value);
    if (state === 'checked' || state === 'on' || state === 'selected') return true;
    if (state === 'unchecked' || state === 'off' || state === 'unselected') return false;

    const className = normalizeRole(readRawAttr(attrs, 'class').value);
    if (className) {
        if (CHECKED_CLASS_PATTERN.test(className) || SELECTED_CLASS_PATTERN.test(className)) {
            if (!UNCHECKED_CLASS_PATTERN.test(className) && !UNSELECTED_CLASS_PATTERN.test(className)) {
                return true;
            }
        }
        if (UNCHECKED_CLASS_PATTERN.test(className) || UNSELECTED_CLASS_PATTERN.test(className)) {
            return false;
        }
    }

    return false;
};

const resolveBooleanState = (attrs: Record<string, string>, keys: string[]): boolean | undefined => {
    for (const key of keys) {
        const raw = readRawAttr(attrs, key);
        if (!raw.found) continue;
        const parsed = parseBooleanAttr(raw.value, raw.found);
        if (parsed !== undefined) return parsed;
    }
    return undefined;
};

const resolveInvalidState = (attrs: Record<string, string>): boolean => {
    const raw = readRawAttr(attrs, 'aria-invalid');
    if (!raw.found) return false;
    const value = normalizeRole(raw.value);
    if (!value) return true;
    if (value === 'false' || value === '0' || value === 'no') return false;
    return true;
};

const parseBooleanAttr = (value: string | undefined, found: boolean): boolean | undefined => {
    if (!found) return undefined;
    const normalized = normalizeRole(value);
    if (!normalized) return true;

    if (TRUE_SET.has(normalized)) return true;
    if (FALSE_SET.has(normalized)) return false;
    return true;
};

const formatKeyValueToken = (key: string, rawValue: string): string => {
    const value = normalizeContentTokenValue(rawValue);
    return `${key}="${value}"`;
};

const readAttrValue = (attrs: Record<string, string>, key: string): string | undefined => {
    const raw = readRawAttr(attrs, key);
    if (!raw.found) return undefined;
    return normalizeText(raw.value);
};

const readRawAttr = (attrs: Record<string, string>, key: string): { found: boolean; value?: string } => {
    if (!hasOwn(attrs, key)) {
        return { found: false };
    }
    return { found: true, value: attrs[key] };
};

const hasAnyAttr = (attrs: Record<string, string>, keys: string[]): boolean => {
    return keys.some((key) => hasOwn(attrs, key));
};

const dedupeTokens = (tokens: string[]): string[] => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
        if (!token) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        unique.push(token);
    }
    return unique;
};

const hasOwn = (record: Record<string, string>, key: string): boolean => {
    return Object.prototype.hasOwnProperty.call(record, key);
};

const normalizeRole = (value: string | undefined): string => {
    return (value || '').trim().toLowerCase();
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const INTERACTIVE_ROLES = new Set([
    'textbox',
    'textarea',
    'searchbox',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'switch',
    'button',
    'menuitem',
    'option',
]);
const INTERACTIVE_TAGS = new Set(['input', 'textarea', 'select', 'button']);

const CHECKABLE_INPUT_TYPES = new Set(['checkbox', 'radio']);
const TEXT_INPUT_TYPES = new Set([
    '',
    'text',
    'search',
    'email',
    'password',
    'tel',
    'url',
    'number',
]);

const TRUE_SET = new Set([
    'true',
    '1',
    'yes',
    'on',
    'checked',
    'selected',
    'disabled',
    'readonly',
    'expanded',
    'pressed',
]);
const FALSE_SET = new Set([
    'false',
    '0',
    'no',
    'off',
    'unchecked',
    'unselected',
    'collapsed',
    'unpressed',
]);

const CHECKED_CLASS_PATTERN = /\b(checked|is-checked|ant-checkbox-checked|ant-radio-checked)\b/;
const UNCHECKED_CLASS_PATTERN = /\b(unchecked|is-unchecked)\b/;
const SELECTED_CLASS_PATTERN = /\b(selected|is-selected|active)\b/;
const UNSELECTED_CLASS_PATTERN = /\b(unselected|is-unselected)\b/;
