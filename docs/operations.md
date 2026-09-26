# 部署与运维

## 健康检查

- API 存活：`GET /health/live`
- API 就绪：`GET /health/ready`
- PostgreSQL：`pg_isready`
- Redis：`redis-cli ping`
- MinIO：`mc ready local`
- ClamAV：`clamdcheck.sh`

## 关键监控

- API 错误率、p50/p95/p99 延迟。
- PostgreSQL 连接数、慢查询和磁盘使用率。
- Redis 内存、BullMQ 等待任务和失败任务。
- `media_assets` 中 `processing` 或 `failed` 数量。
- `manual_review` 媒体队列长度。
- `pending` 内容与评论队列长度。
- outbox `pending`、`failed` 数量。
- `delete_after <= now()` 的原图数量。
- 公开桶中是否存在未被数据库引用的对象。
- 检索索引滞后：`GET /api/v1/admin/search/status` 中检查点与当前时间的差值（正常 < 1 分钟）。

## 检索索引

- 索引存储在 `search_documents` 表，由 Worker 每 15 秒增量同步（批量 upsert），每 60 秒清理已删除内容的文档。
- 索引表不建外键，内容写入不等待索引；可见性由查询层按内容表实时过滤，索引滞后不会泄露未公开内容。
- 全量重建：`POST /api/v1/admin/search/reindex`（管理员）。重建在 Worker 中分批小事务执行，不清空索引表，重建期间查询与写入均不受影响；通过 `GET /api/v1/admin/search/status` 观察进度。
- 首次部署或迁移 `0003_search_documents.sql` 后应触发一次全量重建，将存量内容纳入索引。
- 同步水位为 5 秒：超过 5 秒未提交的长事务中的变更会在下一同步周期被拾起；极端情况下可通过全量重建兜底。

## 备份

- PostgreSQL 每日全量备份并保留 WAL 或等价连续归档。
- MinIO 启用版本化和跨盘/跨区域容灾时，分别备份隔离桶和公开桶。
- `.env.production` 和密钥应保存在密钥管理系统，不进入镜像或仓库。
- 每季度执行一次恢复演练，验证数据库、公开媒体和迁移记录。

## 发布

1. 构建并锁定 API、Worker、Web 镜像。
2. 备份数据库。
3. 执行一次 `migrate` 容器。
4. 启动新 API 和 Worker。
5. 验证就绪检查、登录、地图查询和媒体处理。
6. 再切换 Caddy 流量。
7. 保留上一版本镜像用于回滚。

## 隐私事件

发现未模糊媒体或原图泄露时：

1. 立即停止相关媒体发布并删除公开对象。
2. 暂停媒体 Worker，防止继续复制到公开桶。
3. 根据对象访问日志确认影响范围。
4. 修复处理管线并执行全量扫描。
5. 删除或隔离受影响对象。
6. 记录事故、根因、修复和回归测试。
7. 按法律与运营要求通知用户。

## 数据保留

- 成功处理原图：24 小时。
- 失败处理原图：最多 7 天。
- 邮箱验证令牌：24 小时。
- 密码重置令牌：30 分钟。
- 过期刷新令牌：30 天清理。
- 账号删除冷静期：30 天。
- 审计与审核记录：默认 180 天，生产可按法务要求延长。
