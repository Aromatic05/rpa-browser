const { createApp } = Vue;

const TreeNode = {
    name: 'TreeNode',
    props: {
        node: { type: Object, required: true },
        depth: { type: Number, default: 0 },
        selectedId: { type: String, default: '' },
    },
    emits: ['select'],
    data() {
        return { open: this.depth < 2 };
    },
    computed: {
        hasChildren() {
            return Array.isArray(this.node.children) && this.node.children.length > 0;
        },
        isSelected() {
            return this.selectedId === this.node.id;
        },
    },
    methods: {
        toggle(event) {
            event.stopPropagation();
            if (!this.hasChildren) return;
            this.open = !this.open;
        },
        selectNode() {
            this.$emit('select', this.node);
        },
    },
    template: `
        <div class="tree-node">
            <div class="tree-line" :class="{ selected: isSelected }" @click="selectNode">
                <span class="badge" @click="toggle">{{ hasChildren ? (open ? '-' : '+') : '·' }}</span>
                <span>{{ node.role || node.tag || 'node' }}</span>
                <span class="badge">{{ node.id }}</span>
                <span v-if="node.name">{{ node.name }}</span>
                <span v-else-if="node.text">{{ node.text }}</span>
            </div>
            <div v-if="hasChildren && open" class="tree-children">
                <TreeNode
                    v-for="child in node.children"
                    :key="child.id"
                    :node="child"
                    :depth="depth + 1"
                    :selected-id="selectedId"
                    @select="$emit('select', $event)"
                />
            </div>
        </div>
    `,
};

const normalizeNode = (value, fallbackId = 'n0') => {
    if (!value || typeof value !== 'object') return null;
    const id = typeof value.id === 'string' ? value.id : fallbackId;
    const children = Array.isArray(value.children)
        ? value.children
              .map((child, index) => normalizeNode(child, `${id}.${index}`))
              .filter(Boolean)
        : [];
    return {
        id,
        role: typeof value.role === 'string' ? value.role : undefined,
        tag: typeof value.tag === 'string' ? value.tag : undefined,
        name: typeof value.name === 'string' ? value.name : undefined,
        text: typeof value.text === 'string' ? value.text : undefined,
        attrs: value.attrs && typeof value.attrs === 'object' ? value.attrs : undefined,
        children,
    };
};

createApp({
    components: { TreeNode },
    data() {
        return {
            source: 'unifiedGraph',
            error: '',
            jsonInput: '',
            selectedNode: null,
            dataPack: {
                domTree: null,
                a11yTree: null,
                unifiedGraph: null,
            },
        };
    },
    computed: {
        activeRoot() {
            const raw = this.dataPack[this.source];
            if (!raw) return null;
            const root = this.source === 'unifiedGraph' && raw.root ? raw.root : raw;
            return normalizeNode(root, 'n0');
        },
    },
    methods: {
        async loadSample() {
            this.error = '';
            try {
                const res = await fetch('./sample-data.json');
                const sample = await res.json();
                this.dataPack = sample;
                this.selectedNode = null;
            } catch (error) {
                this.error = `load sample failed: ${String(error)}`;
            }
        },
        onSelect(node) {
            this.selectedNode = node;
        },
        onFileChange(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                this.jsonInput = String(reader.result || '');
            };
            reader.readAsText(file);
        },
        applyJson() {
            this.error = '';
            try {
                const parsed = JSON.parse(this.jsonInput || '{}');
                this.dataPack = {
                    domTree: parsed.domTree || null,
                    a11yTree: parsed.a11yTree || null,
                    unifiedGraph: parsed.unifiedGraph || (parsed.root ? { root: parsed.root } : null),
                };
                this.selectedNode = null;
            } catch (error) {
                this.error = `invalid json: ${String(error)}`;
            }
        },
    },
    mounted() {
        this.loadSample();
    },
    template: `
        <div class="panel">
            <div class="section">
                <h2>Data Source</h2>
                <select v-model="source">
                    <option value="domTree">DOM tree</option>
                    <option value="a11yTree">A11y tree</option>
                    <option value="unifiedGraph">Unified graph</option>
                </select>
            </div>
            <div class="section">
                <h2>Load JSON</h2>
                <input type="file" accept="application/json" @change="onFileChange" />
                <textarea rows="9" v-model="jsonInput" placeholder="paste json here"></textarea>
                <button @click="applyJson">Apply JSON</button>
                <button class="secondary" @click="loadSample">Load Sample</button>
                <div v-if="error" style="margin-top:8px;color:#b42318;font-size:12px;">{{ error }}</div>
            </div>
        </div>

        <div class="panel">
            <div class="section">
                <h2>Tree</h2>
            </div>
            <div class="tree-wrap">
                <TreeNode
                    v-if="activeRoot"
                    :node="activeRoot"
                    :selected-id="selectedNode ? selectedNode.id : ''"
                    @select="onSelect"
                />
                <div v-else style="font-size:12px;color:#6a7892;">no tree data</div>
            </div>
        </div>

        <div class="panel">
            <div class="section">
                <h2>Node Detail</h2>
            </div>
            <div class="section" v-if="selectedNode">
                <div class="kv"><span class="k">id</span><span>{{ selectedNode.id }}</span></div>
                <div class="kv"><span class="k">role</span><span>{{ selectedNode.role || '-' }}</span></div>
                <div class="kv"><span class="k">name</span><span>{{ selectedNode.name || '-' }}</span></div>
                <div class="kv"><span class="k">text</span><span>{{ selectedNode.text || '-' }}</span></div>
                <div class="kv"><span class="k">attrs</span></div>
                <pre>{{ JSON.stringify(selectedNode.attrs || {}, null, 2) }}</pre>
            </div>
            <div class="section" v-else>
                <div style="font-size:12px;color:#6a7892;">click one node in tree</div>
            </div>
        </div>
    `,
}).mount('#app');
