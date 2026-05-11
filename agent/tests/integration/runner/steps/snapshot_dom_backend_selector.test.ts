import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackendDomSelectorMap } from '../../../src/runner/steps/executors/snapshot/indexes/dom_backend_selector';

test('buildBackendDomSelectorMap builds full css chain by backendDOMNodeId', () => {
    const domTree = {
        id: 'n0',
        tag: 'html',
        backendDOMNodeId: '10',
        children: [
            {
                id: 'n0.0',
                tag: 'body',
                backendDOMNodeId: '11',
                children: [
                    {
                        id: 'n0.0.0',
                        tag: 'section',
                        backendDOMNodeId: '12',
                        children: [
                            {
                                id: 'n0.0.0.0',
                                tag: 'select',
                                backendDOMNodeId: '21',
                                children: [],
                            },
                            {
                                id: 'n0.0.0.1',
                                tag: 'select',
                                backendDOMNodeId: '22',
                                children: [],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const map = buildBackendDomSelectorMap(domTree);
    assert.equal(map['10'], 'html:nth-of-type(1)');
    assert.equal(map['11'], 'html:nth-of-type(1) > body:nth-of-type(1)');
    assert.equal(map['21'], 'html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1) > select:nth-of-type(1)');
    assert.equal(map['22'], 'html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1) > select:nth-of-type(2)');
});
