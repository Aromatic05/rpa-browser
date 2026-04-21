import { Pagination } from 'antd';

export const PaginationBar = ({ page, pageSize, total }: { page: number; pageSize: number; total: number }) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} />
    </div>
);
