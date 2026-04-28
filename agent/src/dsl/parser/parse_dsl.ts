import YAML from 'yaml';
import type { CheckpointStmt, DslProgram, DslStmt, LetStmt, QueryExpr, RefExpr } from '../ast/types';
import { DslParseError } from '../diagnostics/errors';

export const parseDsl = (source: string): DslProgram => {
    const statements = splitStatements(source);
    return {
        body: statements.map(parseStatement),
    };
};

const splitStatements = (source: string): string[] => {
    const lines = source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const statements: string[] = [];
    let buffer: string[] = [];
    let depth = 0;

    for (const line of lines) {
        buffer.push(line);
        depth += countChar(line, '{');
        depth -= countChar(line, '}');
        if (depth < 0) {
            throw new DslParseError('unbalanced braces in DSL source');
        }
        if (depth === 0) {
            statements.push(buffer.join('\n'));
            buffer = [];
        }
    }

    if (buffer.length > 0 || depth !== 0) {
        throw new DslParseError('unterminated DSL statement');
    }

    return statements;
};

const parseStatement = (statement: string): DslStmt => {
    if (statement.startsWith('let ')) {
        return parseLet(statement);
    }
    if (statement.startsWith('fill ')) {
        const match = statement.match(/^fill\s+([A-Za-z0-9_.]+)\s+with\s+([A-Za-z0-9_.]+)$/);
        if (!match) {
            throw new DslParseError(`invalid fill statement: ${statement}`);
        }
        return {
            kind: 'act',
            action: 'fill',
            target: toRef(match[1]),
            value: toRef(match[2]),
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
    if (statement.startsWith('use checkpoint ')) {
        return parseCheckpoint(statement);
    }
    if (statement.startsWith('if ')) {
        return {
            kind: 'if',
            condition: toRef(statement.slice(3).trim()),
            then: [],
        };
    }
    if (statement.startsWith('for ')) {
        const match = statement.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z0-9_.]+)$/);
        if (!match) {
            throw new DslParseError(`invalid for statement: ${statement}`);
        }
        return {
            kind: 'for',
            item: match[1],
            iterable: toRef(match[2]),
            body: [],
        };
    }
    throw new DslParseError(`unsupported DSL statement: ${statement}`);
};

const parseLet = (statement: string): LetStmt => {
    const match = statement.match(/^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*query\s+(entity(?:\.target)?)\s+"([^"]+)"\s+([\s\S]+)$/);
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
