import YAML from 'yaml';
import type { CheckpointStmt, DslProgram, DslStmt, LetStmt, QueryExpr, RefExpr } from '../ast/types';
import { DslParseError } from '../diagnostics/errors';

type ParsedLine = {
    indent: number;
    content: string;
};

export const parseDsl = (source: string): DslProgram => {
    const lines = tokenizeDsl(source);
    const parsed = parseBlock(lines, 0, 0, { allowElse: false });
    if (parsed.nextIndex !== lines.length) {
        throw new DslParseError('unexpected trailing DSL content');
    }
    return { body: parsed.body };
};

const tokenizeDsl = (source: string): ParsedLine[] => {
    const rawLines = source
        .split(/\r?\n/)
        .map((rawLine) => rawLine.replace(/\s+$/, ''))
        .filter((line) => line.trim().length > 0);
    const baseIndent = rawLines.reduce((min, line) => {
        const indent = line.length - line.trimStart().length;
        return Math.min(min, indent);
    }, Number.POSITIVE_INFINITY);

    return rawLines.map((line) => {
            if (line.includes('\t')) {
                throw new DslParseError('tabs are not supported in DSL indentation');
            }
            const indent = line.length - line.trimStart().length - (Number.isFinite(baseIndent) ? baseIndent : 0);
            if (indent % 2 !== 0) {
                throw new DslParseError(`invalid DSL indentation: ${line}`);
            }
            return {
                indent,
                content: line.trimStart(),
            };
        });
};

const parseBlock = (
    lines: ParsedLine[],
    startIndex: number,
    indent: number,
    opts: { allowElse: boolean },
): { body: DslStmt[]; nextIndex: number } => {
    const body: DslStmt[] = [];
    let index = startIndex;

    while (index < lines.length) {
        const line = lines[index];
        if (line.indent < indent) {
            break;
        }
        if (line.indent > indent) {
            throw new DslParseError(`invalid DSL indentation: ${line.content}`);
        }
        if (line.content === 'else:') {
            if (opts.allowElse) {
                break;
            }
            throw new DslParseError('else without matching if');
        }

        if (line.content.startsWith('if ')) {
            const parsedIf = parseIfStmt(lines, index, indent);
            body.push(parsedIf.stmt);
            index = parsedIf.nextIndex;
            continue;
        }

        if (line.content.startsWith('for ')) {
            const parsedFor = parseForStmt(lines, index, indent);
            body.push(parsedFor.stmt);
            index = parsedFor.nextIndex;
            continue;
        }

        const collected = collectStatement(lines, index, indent);
        body.push(parseStatement(collected.statement));
        index = collected.nextIndex;
    }

    return { body, nextIndex: index };
};

const parseIfStmt = (
    lines: ParsedLine[],
    startIndex: number,
    indent: number,
): { stmt: DslStmt; nextIndex: number } => {
    const header = lines[startIndex].content;
    if (!header.endsWith(':')) {
        throw new DslParseError(`if statement must end with ":": ${header}`);
    }
    const conditionSource = header.slice(3, -1).trim();
    if (!conditionSource) {
        throw new DslParseError(`invalid if statement: ${header}`);
    }

    const thenBlock = parseBlock(lines, startIndex + 1, indent + 2, { allowElse: true });
    let nextIndex = thenBlock.nextIndex;
    let elseBody: DslStmt[] | undefined;

    if (nextIndex < lines.length && lines[nextIndex].indent === indent && lines[nextIndex].content === 'else:') {
        const elseBlock = parseBlock(lines, nextIndex + 1, indent + 2, { allowElse: false });
        elseBody = elseBlock.body;
        nextIndex = elseBlock.nextIndex;
    }

    return {
        stmt: {
            kind: 'if',
            condition: toRef(conditionSource),
            then: thenBlock.body,
            else: elseBody,
        },
        nextIndex,
    };
};

const parseForStmt = (
    lines: ParsedLine[],
    startIndex: number,
    indent: number,
): { stmt: DslStmt; nextIndex: number } => {
    const header = lines[startIndex].content;
    if (!header.endsWith(':')) {
        throw new DslParseError(`for statement must end with ":": ${header}`);
    }
    const match = header.slice(0, -1).match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z0-9_.]+)$/);
    if (!match) {
        throw new DslParseError(`invalid for statement: ${header}`);
    }

    const bodyBlock = parseBlock(lines, startIndex + 1, indent + 2, { allowElse: false });
    return {
        stmt: {
            kind: 'for',
            item: match[1],
            iterable: toRef(match[2]),
            body: bodyBlock.body,
        },
        nextIndex: bodyBlock.nextIndex,
    };
};

const collectStatement = (
    lines: ParsedLine[],
    startIndex: number,
    indent: number,
): { statement: string; nextIndex: number } => {
    const statementLines: string[] = [];
    let index = startIndex;
    let depth = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (statementLines.length > 0 && depth === 0 && line.indent <= indent) {
            break;
        }
        if (statementLines.length > 0 && depth === 0 && line.indent > indent) {
            throw new DslParseError(`invalid DSL indentation: ${line.content}`);
        }

        statementLines.push(line.content);
        depth += countChar(line.content, '{');
        depth -= countChar(line.content, '}');
        if (depth < 0) {
            throw new DslParseError('unbalanced braces in DSL source');
        }
        index += 1;

        if (depth === 0) {
            break;
        }
    }

    if (depth !== 0) {
        throw new DslParseError('unterminated DSL statement');
    }

    return {
        statement: statementLines.join('\n'),
        nextIndex: index,
    };
};

const parseStatement = (statement: string): DslStmt => {
    if (statement.startsWith('let ')) {
        return parseLet(statement);
    }
    if (statement.startsWith('fill form ')) {
        const match = statement.match(/^fill\s+form\s+"([^"]+)"\s+field\s+"([^"]+)"\s+with\s+([A-Za-z0-9_.]+)$/);
        if (!match) {
            throw new DslParseError(`invalid fill form statement: ${statement}`);
        }
        return {
            kind: 'form_act',
            action: 'fill',
            businessTag: match[1],
            target: {
                kind: 'field',
                fieldKey: match[2],
            },
            value: toRef(match[3]),
        };
    }
    if (statement.startsWith('click form ')) {
        const withMatch = statement.match(/\s+with\s+/);
        if (withMatch) {
            throw new DslParseError(`invalid click form statement: ${statement}`);
        }
        const match = statement.match(/^click\s+form\s+"([^"]+)"\s+action\s+"([^"]+)"$/);
        if (!match) {
            throw new DslParseError(`invalid click form statement: ${statement}`);
        }
        return {
            kind: 'form_act',
            action: 'click',
            businessTag: match[1],
            target: {
                kind: 'action',
                actionIntent: match[2],
            },
        };
    }
    if (statement.startsWith('fill ') || statement.startsWith('type ') || statement.startsWith('select ')) {
        const match = statement.match(/^(fill|type|select)\s+([A-Za-z0-9_.]+)\s+with\s+([A-Za-z0-9_.]+)$/);
        if (!match) {
            throw new DslParseError(`invalid action statement: ${statement}`);
        }
        return {
            kind: 'act',
            action: match[1] as 'fill' | 'type' | 'select',
            target: toRef(match[2]),
            value: toRef(match[3]),
        };
    }
    if (statement.startsWith('click ')) {
        const match = statement.match(/^click\s+([A-Za-z0-9_.]+)$/);
        if (!match) {
            throw new DslParseError(`invalid click statement: ${statement}`);
        }
        return {
            kind: 'act',
            action: 'click',
            target: toRef(match[1]),
        };
    }
    if (statement.startsWith('wait ')) {
        const match = statement.match(/^wait\s+(\d+)$/);
        if (!match) {
            throw new DslParseError(`invalid wait statement: ${statement}`);
        }
        return {
            kind: 'act',
            action: 'wait',
            durationMs: Number(match[1]),
        };
    }
    if (statement === 'snapshot') {
        return {
            kind: 'act',
            action: 'snapshot',
        };
    }
    if (statement.startsWith('use checkpoint ')) {
        return parseCheckpoint(statement);
    }
    throw new DslParseError(`unsupported DSL statement: ${statement}`);
};

const parseLet = (statement: string): LetStmt => {
    const sugarMatch = statement.match(
        /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*query\s+(table|form)\s+"([^"]+)"\s+([A-Za-z_][A-Za-z0-9_]*)$/,
    );
    if (sugarMatch) {
        const [, name, target, businessTag, op] = sugarMatch;
        if (target === 'table') {
            if (!['currentRows', 'rowCount', 'hasNextPage', 'nextPageTarget'].includes(op)) {
                throw new DslParseError(`invalid table query op: ${op}`);
            }
            return {
                kind: 'let',
                name,
                expr: {
                    kind: 'querySugar',
                    target: 'table',
                    businessTag,
                    op: op as 'currentRows' | 'rowCount' | 'hasNextPage' | 'nextPageTarget',
                },
            };
        }
        if (!['fields', 'actions'].includes(op)) {
            throw new DslParseError(`invalid form query op: ${op}`);
        }
        return {
            kind: 'let',
            name,
            expr: {
                kind: 'querySugar',
                target: 'form',
                businessTag,
                op: op as 'fields' | 'actions',
            },
        };
    }

    const match = statement.match(
        /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*query\s+(entity(?:\.target)?)\s+"([^"]+)"\s+([\s\S]+)$/,
    );
    if (!match) {
        throw new DslParseError(`invalid let statement: ${statement}`);
    }

    const expr: QueryExpr = {
        kind: 'query',
        op: match[2] as QueryExpr['op'],
        businessTag: match[3],
        payload: parseObjectLiteral(match[4]),
    };

    return {
        kind: 'let',
        name: match[1],
        expr,
    };
};


const parseCheckpoint = (statement: string): CheckpointStmt => {
    const match = statement.match(/^use\s+checkpoint\s+"([^"]+)"(?:\s+with\s+([\s\S]+))?$/);
    if (!match) {
        throw new DslParseError(`invalid checkpoint statement: ${statement}`);
    }

    return {
        kind: 'checkpoint',
        id: match[1],
        input: match[2] ? parseDslObjectRefs(match[2]) : undefined,
    };
};

const parseDslObjectRefs = (source: string): Record<string, RefExpr> => {
    const parsed = parseObjectLiteral(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DslParseError('checkpoint input must be an object literal');
    }

    return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
            if (typeof value !== 'string') {
                throw new DslParseError(`checkpoint input "${key}" must be a reference path`);
            }
            return [key, toRef(value)];
        }),
    );
};

const parseObjectLiteral = (source: string): unknown => {
    try {
        const trimmed = source.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            return YAML.parse(trimmed.slice(1, -1));
        }
        return YAML.parse(trimmed);
    } catch (error) {
        throw new DslParseError(`invalid object literal: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const toRef = (value: string): RefExpr => ({
    kind: 'ref',
    ref: value,
});

const countChar = (source: string, char: string): number => source.split(char).length - 1;
