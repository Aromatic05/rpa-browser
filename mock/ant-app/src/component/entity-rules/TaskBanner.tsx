import { Alert, Space, Typography } from 'antd';

export const TaskBanner = ({ title, description }: { title: string; description: string }) => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
        </Typography.Title>
        <Alert type="info" showIcon message={description} />
    </Space>
);
