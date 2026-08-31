import type {AccessibilityRecord, RuntimeStateRecord} from './contracts';
import type {RawCapturedNode} from './raw_capture';

const SENSITIVE_INPUT_TYPES = new Set(['password', 'hidden']);
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
    'current-password',
    'new-password',
    'one-time-code',
]);
const SENSITIVE_HINT = /(password|passwd|pwd|secret|token|api.?key|credential|private.?key|otp|one.?time.?code)/iu;
const SENSITIVE_ATTRIBUTE_VALUE_KEYS = new Set(['value', 'data-value', 'aria-valuetext']);

export const SENSITIVE_CAPTURE_VALUE_PLACEHOLDER = '[redacted]';

export const isSensitiveCapturedControl = (
    node: Pick<RawCapturedNode, 'tag' | 'attributes'>,
): boolean => {
    const tag = node.tag.trim().toLowerCase();
    const attributes: Partial<Record<string, string>> = node.attributes;
    const type = (attributes.type ?? '').trim().toLowerCase();
    if (tag === 'input' && SENSITIVE_INPUT_TYPES.has(type)) {return true;}

    const autocomplete = (attributes.autocomplete ?? '').trim().toLowerCase();
    if (autocomplete.split(/\s+/u).some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token))) {
        return true;
    }

    return ['name', 'id', 'aria-label', 'autocomplete']
        .map((key) => attributes[key] ?? '')
        .some((value) => SENSITIVE_HINT.test(value));
};

export const redactSensitiveCaptureValues = (input: Readonly<{
    nodes: readonly RawCapturedNode[];
    runtimeState: Readonly<Record<string, RuntimeStateRecord | undefined>>;
    accessibility: readonly AccessibilityRecord[];
}>): Readonly<{
    nodes: RawCapturedNode[];
    runtimeState: Record<string, RuntimeStateRecord | undefined>;
    accessibility: AccessibilityRecord[];
}> => {
    const sensitiveRuntimeTokens = new Set<string>();
    const sensitiveBackendNodeIds = new Set<string>();

    const nodes = input.nodes.map((node) => {
        if (!isSensitiveCapturedControl(node)) {return node;}
        if (node.runtimeStateToken) {sensitiveRuntimeTokens.add(node.runtimeStateToken);}
        if (node.backendNodeId) {sensitiveBackendNodeIds.add(node.backendNodeId);}
        const attributes = {...node.attributes};
        for (const key of SENSITIVE_ATTRIBUTE_VALUE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(attributes, key)) {
                attributes[key] = SENSITIVE_CAPTURE_VALUE_PLACEHOLDER;
            }
        }
        return {...node, attributes};
    });

    const runtimeState = Object.fromEntries(Object.entries(input.runtimeState).map(([token, record]) => {
        if (!record || !sensitiveRuntimeTokens.has(token)) {return [token, record] as const;}
        return [token, redactRuntimeRecord(record)] as const;
    }));

    const accessibility = input.accessibility.map((record) =>
        record.backendNodeId && sensitiveBackendNodeIds.has(record.backendNodeId)
            ? {...record, value: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}
            : record);

    return {nodes, runtimeState, accessibility};
};

const redactRuntimeRecord = (record: RuntimeStateRecord): RuntimeStateRecord => ({
    ...record,
    ...(record.value === undefined ? {} : {value: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}),
    ...(record.selected === undefined ? {} : {selected: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}),
    ...(record.popupSelectedText === undefined ? {} : {popupSelectedText: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}),
    ...(record.ariaValueText === undefined ? {} : {ariaValueText: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}),
    ...(record.contentEditableText === undefined ? {} : {contentEditableText: SENSITIVE_CAPTURE_VALUE_PLACEHOLDER}),
});
