export type ProgramDslExample = Readonly<{
    purpose: string;
    source: string;
}>;

export const PROGRAM_DSL_EXAMPLES: readonly ProgramDslExample[] = Object.freeze([
    Object.freeze({
        purpose: 'Return an input value',
        source: 'output ok = input.ok',
    }),
    Object.freeze({
        purpose: 'Compute, verify, and return a derived value',
        source: [
            'let count = compute len(input.items)',
            'let ok = compute eq(count, input.expected)',
            'ensure ok',
            'output result = ok',
        ].join('\n'),
    }),
    Object.freeze({
        purpose: 'Perform browser mutations through structured targets',
        source: [
            'fill input.target with input.value',
            'click input.submit',
        ].join('\n'),
    }),
    Object.freeze({
        purpose: 'Resolve a business field logically at execution time',
        source: [
            'let target = query entity.target "order.form.main" {',
            '  kind: "form.field"',
            '  fieldKey: "orderNo"',
            '}',
            'fill target with input.value',
        ].join('\n'),
    }),
    Object.freeze({
        purpose: 'Use structured control flow',
        source: [
            'if input.enabled:',
            '  output result = input.value',
            'else:',
            '  output result = input.fallback',
        ].join('\n'),
    }),
]);

const examples = PROGRAM_DSL_EXAMPLES
    .map((example) => `${example.purpose}:\n${example.source}`)
    .join('\n\n');

export const PROGRAM_DSL_AUTHORING_GUIDE = [
    'Author only the DSL syntax described here; do not invent Python/JavaScript assignment syntax.',
    'A direct value is emitted with `output name = value`, for example `output ok = input.ok`.',
    '`let` is only for query or compute statements. Never write `let x = input.x`; use the input ref directly or `output x = input.x`.',
    'Pure expressions use the `compute` prefix, for example `let count = compute len(input.items)` or `ensure compute eq(input.actual, input.expected)`.',
    'Do not emit bare `true`, `false`, or `null` values. Put constants in structured program input and reference them through input.*.',
    'Use input.*, vars.*, output.*, failure.* (recovery only), and active local loop variables as value roots. A previously defined let binding may be referenced by its local name.',
    'Browser mutations use `fill TARGET with VALUE` and `click TARGET`. Keep concrete values in structured program input.',
    'Only when browser inspection already exposes a stable businessTag and semantic field/action identity, prefer resolving the target inside the Program with `query entity.target "BUSINESS_TAG" { ... }` instead of freezing a one-capture nodeId into input.',
    'Never guess a businessTag. For a business form field, query `entity.target` with `kind: "form.field"` and its stable `fieldKey`, using the exact businessTag already exposed by business annotations.',
    'Use an explicit target object in structured input only when no logical business target is available.',
    'Control flow uses `if VALUE:` / `else:` and `for item in VALUE:` with indentation. Do not use braces.',
    'Do not wrap submitted DSL source in Markdown fences.',
    `Compiler-valid examples:\n${examples}`,
].join('\n');
