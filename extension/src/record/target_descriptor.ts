/**
 * target_descriptor：生成轻量可序列化的目标描述。
 *
 * 设计说明：
 * - 只保留最小必要字段，避免传递 Element 引用。
 * - selector 只做极简拼装，防止过度推理导致不稳定。
 */

export type TargetDescriptor = {
    tag: string;
    id?: string;
    name?: string;
    type?: string;
    role?: string;
    ariaLabel?: string;
    text?: string;
    selector?: string;
};

const collapseSpaces = (value: string) => value.replace(/\s+/g, ' ').trim();

const safeEscape = (value: string) => {
    if (typeof (globalThis as any).CSS?.escape === 'function') {
        return (globalThis as any).CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
};

const buildSelector = (el: Element, tag: string, id?: string, nameAttr?: string) => {
    if (id) return `#${safeEscape(id)}`;
    if (nameAttr && nameAttr.length < 64) return `${tag}[name="${safeEscape(nameAttr)}"]`;
    const classes = Array.from(el.classList || []).filter(Boolean).slice(0, 2);
    if (classes.length) {
        return `${tag}.${classes.map(safeEscape).join('.')}`;
    }
    return tag;
};

export const describeTarget = (el: Element): TargetDescriptor => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id') || undefined;
    const nameAttr = el.getAttribute('name') || undefined;
    const typeAttr = el.getAttribute('type') || undefined;
    const roleAttr = el.getAttribute('role') || undefined;
    const ariaLabel = el.getAttribute('aria-label') || undefined;
    const rawText = el.textContent || '';
    const text = rawText ? collapseSpaces(rawText).slice(0, 80) : undefined;

    return {
        tag,
        id,
        name: nameAttr,
        type: typeAttr,
        role: roleAttr,
        ariaLabel,
        text,
        selector: buildSelector(el, tag, id, nameAttr),
    };
};
