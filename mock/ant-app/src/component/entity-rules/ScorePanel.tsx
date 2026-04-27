import { Card, List, Progress, Tag, Typography } from 'antd';
import type { ScoreResult } from '../../types/entity-rules';

export const ScorePanel = ({ result }: { result?: ScoreResult }) => {
    if (!result) return null;

    return (
        <Card title={`评分结果 ${result.score}/${result.maxScore}`}>
            <Progress percent={Math.round((result.score / result.maxScore) * 100)} />
            <List
                dataSource={result.items}
                renderItem={(item) => (
                    <List.Item>
                        <Typography.Text>{item.key}</Typography.Text>
                        <Tag color={item.ok ? 'green' : 'red'}>{item.ok ? `+${item.score}` : '0'}</Tag>
                    </List.Item>
                )}
            />
        </Card>
    );
};
