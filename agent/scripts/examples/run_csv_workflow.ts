import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {sendControlEval} from '../../src/interface/control/client';

type Row = {line: number; input: Record<string, string>};
type RowResult = {line: number; status: 'completed' | 'failed' | 'unconfirmed'; code?: string};
type BatchOptions = {workspaceName: string; dslName: string; endpoint?: string; selectorColumn?: string};

export const parseCsvRows = (source: string): Row[] => {
    const csv = source.replace(/^\uFEFF/, '');
    const records: Array<{line: number; fields: string[]}> = [];
    let line = 1;
    let recordLine = 1;
    let fields: string[] = [];
    let field = '';
    let mode: 'plain' | 'quoted' | 'closed' = 'plain';
    const endField = () => {
        fields.push(field);
        field = '';
        mode = 'plain';
    };
    const endRecord = () => {
        if (fields.length || field.length || mode === 'closed') {
            endField();
            records.push({line: recordLine, fields});
            fields = [];
        }
    };

    for (let index = 0; index < csv.length; index += 1) {
        const char = csv[index];
        if (char === '\r' || char === '\n') {
            const newline = char === '\r' && csv[index + 1] === '\n' ? '\r\n' : char;
            if (newline.length === 2) {index += 1;}
            line += 1;
            if (mode === 'quoted') {
                field += newline;
            } else {
                endRecord();
                recordLine = line;
            }
        } else if (mode === 'quoted') {
            if (char === '"' && csv[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                mode = 'closed';
            } else {
                field += char;
            }
        } else if (char === ',') {
            endField();
        } else if (char === '"' && mode === 'plain' && field === '') {
            mode = 'quoted';
        } else if (char === '"' || mode === 'closed') {
            throw new Error(`CSV line ${line}: unexpected character after or inside an unquoted field`);
        } else {
            field += char;
        }
    }
    if (mode === 'quoted') {throw new Error(`CSV line ${recordLine}: unclosed quoted field`);}
    endRecord();

    const header = records.shift();
    if (!header) {throw new Error('CSV needs a header and at least one data row');}
    const names = header.fields.map((name) => name.trim());
    const reserved = new Set(['__proto__', 'constructor', 'prototype']);
    if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name))
        || new Set(names).size !== names.length) {
        throw new Error(`CSV line ${header.line}: headers must be distinct DSL input names`);
    }
    if (!records.length) {throw new Error('CSV needs at least one data row');}
    return records.map(({line, fields}) => {
        if (fields.length !== names.length) {
            throw new Error(`CSV line ${line}: expected ${names.length} columns, got ${fields.length}`);
        }
        return {line, input: Object.fromEntries(names.map((name, index) => [name, fields[index]]))};
    });
};

const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? value as Record<string, unknown> : {};

export const runSavedCsvWorkflow = async (csv: string, options: BatchOptions): Promise<RowResult[]> => {
    const rows = parseCsvRows(csv);
    const selectorColumn = options.selectorColumn;
    if (selectorColumn && rows.some((row) => !Object.hasOwn(row.input, selectorColumn) || !row.input[selectorColumn].trim())) {
        throw new Error('The selector column must exist and contain a non-empty selector in every row');
    }
    const results: RowResult[] = [];
    for (const row of rows) {
        try {
            const cells = selectorColumn
                ? {...row.input, [selectorColumn]: {selector: row.input[selectorColumn]}}
                : row.input;
            const response = await sendControlEval({
                source: 'return await ctx.dispatch({v: 1, id: input.id, type: "dsl.run", workspaceName: input.workspaceName, payload: {dslName: input.dslName, input: input.cells}});',
                input: {id: randomUUID(), workspaceName: options.workspaceName, dslName: options.dslName, cells},
                timeoutMs: 30_000,
            }, {endpoint: options.endpoint, timeoutMs: 31_000});
            const action = object(response.result);
            if (response.ok && action.type === 'dsl.run.result') {
                results.push({line: row.line, status: 'completed'});
                continue;
            }
            if (response.ok && action.type === 'dsl.run.failed') {
                const code = object(action.payload).code;
                results.push({line: row.line, status: 'failed', ...(typeof code === 'string' ? {code} : {})});
                continue;
            }
            results.push({line: row.line, status: 'unconfirmed', code: response.error?.code});
        } catch {
            results.push({line: row.line, status: 'unconfirmed', code: 'ERR_CONTROL_TRANSPORT'});
        }
        // The row may have performed an action before a disconnect or timeout.
        // Do not retry it or start the next row without a confirmed outcome.
        break;
    }
    return results;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const {positionals, values} = parseArgs({
            options: {endpoint: {type: 'string'}, 'selector-column': {type: 'string'}},
            allowPositionals: true,
        });
        const [workspaceName, dslName, csvPath] = positionals;
        if (positionals.length !== 3 || !workspaceName || !dslName || !csvPath) {
            throw new Error('Usage: pnpm --filter ./agent demo:csv <workspace> <saved-dsl> <csv-path> [--selector-column name] [--endpoint address]');
        }
        const results = await runSavedCsvWorkflow(await readFile(csvPath, 'utf8'), {
            workspaceName, dslName, endpoint: values.endpoint, selectorColumn: values['selector-column'],
        });
        console.log(JSON.stringify(results, null, 2));
        process.exitCode = results.every((row) => row.status === 'completed') ? 0 : 1;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
