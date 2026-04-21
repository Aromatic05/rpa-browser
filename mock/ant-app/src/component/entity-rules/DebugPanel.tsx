import { Card } from 'antd';

export const DebugPanel = ({ data }: { data: unknown }) => (
    <Card title="结构化结果" size="small">
        <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(data, null, 2)}</pre>
    </Card>
);
