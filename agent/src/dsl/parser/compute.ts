import type {ComputeExpr, ComputeValue} from '../../compute/types';
import {isComputeOp} from '../../compute/ops';
import {DslParseError} from '../diagnostics/errors';

class ComputeParser {
    private index = 0;

    constructor(private readonly source: string) {}

    parseValue(): ComputeValue {
        this.skipWhitespace();
        if (this.index >= this.source.length) {
            throw new DslParseError('expected compute value');
        }
        const current = this.source[this.index];
        if (current === '"') {return {literal: this.parseString()};}
        if (current === '-' || /[0-9]/.test(current)) {return {literal: this.parseNumber()};}

        const identifier = this.parseIdentifier();
        if (identifier === 'true') {return {literal: true};}
        if (identifier === 'false') {return {literal: false};}
        if (identifier === 'null') {return {literal: null};}

        this.skipWhitespace();
        if (this.source[this.index] !== '(') {
            return {ref: {path: identifier}};
        }
        if (!isComputeOp(identifier)) {
            throw new DslParseError(`unsupported compute op: ${identifier}`);
        }
        this.index += 1;
        const args: ComputeValue[] = [];
        this.skipWhitespace();
        if (this.source[this.index] === ')') {
            this.index += 1;
            return {op: identifier, args};
        }
        while (true) {
            args.push(this.parseValue());
            this.skipWhitespace();
            const delimiter = this.source[this.index];
            if (delimiter === ')') {
                this.index += 1;
                break;
            }
            if (delimiter !== ',') {
                throw new DslParseError(`expected "," or ")" in compute expression at column ${this.index + 1}`);
            }
            this.index += 1;
            this.skipWhitespace();
            if (this.source[this.index] === ')') {
                throw new DslParseError('expected compute value after comma');
            }
        }
        return {op: identifier, args};
    }

    expectEnd(): void {
        this.skipWhitespace();
        if (this.index !== this.source.length) {
            throw new DslParseError(`unexpected compute input at column ${this.index + 1}`);
        }
    }

    private parseIdentifier(): string {
        const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
        if (!match) {
            throw new DslParseError(`invalid compute value at column ${this.index + 1}`);
        }
        this.index += match[0].length;
        return match[0];
    }

    private parseString(): string {
        const start = this.index;
        this.index += 1;
        let escaped = false;
        while (this.index < this.source.length) {
            const value = this.source[this.index];
            if (!escaped && value === '"') {
                this.index += 1;
                try {
                    return JSON.parse(this.source.slice(start, this.index)) as string;
                } catch (error) {
                    throw new DslParseError(`invalid compute string: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (!escaped && value === '\\') {
                escaped = true;
            } else {
                escaped = false;
            }
            this.index += 1;
        }
        throw new DslParseError('unterminated compute string');
    }

    private parseNumber(): number {
        const match = this.source.slice(this.index).match(/^-?(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?/);
        if (!match) {throw new DslParseError(`invalid compute number at column ${this.index + 1}`);}
        this.index += match[0].length;
        const value = Number(match[0]);
        if (!Number.isFinite(value)) {throw new DslParseError(`invalid compute number: ${match[0]}`);}
        return value;
    }

    private skipWhitespace(): void {
        while (this.index < this.source.length && /\s/.test(this.source[this.index])) {
            this.index += 1;
        }
    }
}

const isComputeExpr = (value: ComputeValue): value is ComputeExpr =>
    'op' in value && 'args' in value;

export const parseComputeExpression = (source: string): ComputeExpr => {
    const parser = new ComputeParser(source);
    const value = parser.parseValue();
    parser.expectEnd();
    if (!isComputeExpr(value)) {
        throw new DslParseError('compute expression must be an operator call');
    }
    return value;
};
