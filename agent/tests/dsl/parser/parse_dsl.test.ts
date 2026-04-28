import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';

test('parseDsl parses let act and checkpoint statements', () => {
    const program = parseDsl(`
        use checkpoint "ensure_logged_in" with {
          username: input.username
        }

        let buyer = query entity.target "order.form" {
          kind: "form.field"
          fieldKey: "buyer"
        }

        fill buyer with input.user.name
        click buyer
    `);

    assert.equal(program.body.length, 4);
    assert.equal(program.body[0].kind, 'checkpoint');
    assert.equal(program.body[1].kind, 'let');
    assert.equal(program.body[2].kind, 'act');
    assert.equal(program.body[3].kind, 'act');
});
