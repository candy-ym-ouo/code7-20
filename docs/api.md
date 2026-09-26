# API 约定

基础路径：`/api/v1`。

- JSON 请求由 Zod 校验。
- 认证使用 `Authorization: Bearer <token>`。
- 刷新令牌使用 HttpOnly Cookie；刷新请求需要 `X-CSRF-Token`。
- 错误返回类似 RFC 9457 的结构，并包含 `code`、`detail` 和 `requestId`。
- 地图查询必须传 `bbox=minLon,minLat,maxLon,maxLat`，单次跨度限制为 5 度。

## 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/categories` | 分类与详情 schema |
| `GET` | `/features?bbox=...` | 查询已发布地图要素 |
| `GET` | `/features/:id` | 已发布详情；作者和审核员可查看私有状态 |
| `GET` | `/features/:id/comments` | 已发布评论 |
| `GET` | `/features/:id/confirmations` | 时效确认汇总 |
| `GET` | `/search` | 地点与评论全文检索（中文、拼音、标签、分类） |
| `GET` | `/health/live` | 进程存活 |
| `GET` | `/health/ready` | 数据库就绪 |

## 全文检索

`GET /api/v1/search` 同时检索地点与评论，支持组合过滤与稳定键集分页。

| 参数 | 说明 |
|---|---|
| `q` | 关键词，1–100 字符。多个词项之间为 AND |
| `type` | `feature` 或 `comment`，缺省两者都搜 |
| `category` | 分类 key，逗号分隔取并集（如 `bench,drinking_water`） |
| `tag` | 标签，逗号分隔取交集 |
| `sort` | `relevance`（默认）或 `newest` |
| `limit` | 每页条数，1–50，默认 20 |
| `cursor` | 上一页返回的 `nextCursor` 不透明游标 |

匹配能力：

- **中文**：按单字与相邻双字切分。`朝阳` 命中“朝阳公园”，`长椅 休息` 要求两个词项都命中，不会跨空格产生“椅休”之类的噪声词。
- **拼音**：支持全拼（`changyi`、`chang yi`）、紧凑全拼包含匹配（`hangyi`）和首字母前缀（`cygy`）；`ü` 写作 `v`（绿色 → `lvse` / `ls`）。多音字按上下文消歧（“长椅”→ `chang yi`）。
- **拉丁词与数字**：按整词匹配，如 `fountain`、`3`。
- 评论文档继承所属地点的标题/分类文本，因此用地点关键词也能找到其评论。

权限与可见性在**查询层**按调用者身份过滤，索引本身不做权限决策：

- 匿名：只返回 `published` 且未软删的内容；评论还要求所属地点为 `published`。
- 登录用户：额外可见自己的草稿、待审/被拒/隐藏内容。
- 审核员/管理员：可见所有未软删状态。

响应：

```json
{
  "items": [
    {
      "type": "feature",
      "id": "…", "featureId": "…",
      "status": "published", "categoryKey": "bench",
      "title": "…", "snippet": "…", "body": null,
      "authorName": "…", "tags": ["休息"],
      "longitude": 116.4, "latitude": 39.9,
      "sortAt": "2026-09-26T01:00:00.000Z"
    }
  ],
  "nextCursor": "eyJzb3J0IjoibmV3ZXN0Iiwi…"
}
```

- 排序在相关性模式下为 `(score, sort_at, type, id)`，最新模式下为 `(sort_at, type, id)`；末尾三元组恒定唯一，因此翻页期间即使文档重新索引也不会重复或跳项。
- 没有下一页时 `nextCursor` 为 `null`。游标与 `sort` 绑定，混用会返回空页。

索引由 Worker 异步维护（业务写入事务只入队一行轻量变更，不被索引刷新阻塞）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/search/reindex` | 管理员触发在线全量重建（快照入队，Worker 排空并清理孤儿文档，不阻塞写入） |
| `GET` | `/search/reindex` | 管理员查看最近重建状态与积压变更数 |



| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/auth/register` | 注册并加入验证邮件 outbox |
| `POST` | `/auth/verify-email` | 邮箱验证 |
| `POST` | `/auth/login` | 登录并建立刷新会话 |
| `POST` | `/auth/refresh` | 轮换刷新令牌 |
| `POST` | `/auth/logout` | 撤销会话 |
| `POST` | `/auth/password/forgot` | 发送重置邮件 |
| `POST` | `/auth/password/reset` | 重置密码 |
| `GET` | `/me` | 当前用户 |
| `PATCH` | `/me` | 修改昵称 |
| `POST` | `/me/export` | 导出账号数据 |
| `POST` | `/me/delete` | 申请删除账号 |

## 投稿接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/features` | 创建草稿 |
| `PATCH` | `/features/:id/draft` | 更新草稿或被拒内容 |
| `POST` | `/features/:id/submit` | 提交最新草稿 |
| `POST` | `/features/:id/revisions` | 为已发布内容创建修订 |
| `POST` | `/features/:id/revisions/:revisionId/submit` | 提交修订 |
| `GET` | `/features/:id/revisions` | 作者/审核员查看历史 |
| `GET` | `/me/features` | 我的投稿 |
| `DELETE` | `/features/:id` | 软删除 |
| `POST` | `/features/:id/confirmations` | 记录时效确认 |

## 媒体接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/media/uploads` | 创建隔离区签名上传 |
| `POST` | `/media/uploads/:id/complete` | 提交隐私框并启动服务端处理 |
| `GET` | `/media/:id` | 查询处理状态 |
| `GET` | `/media/:id/preview` | 审核员获取短期私有预览 |
| `POST` | `/media/:id/privacy-approve` | 审核员确认隐私并发布派生图 |
| `POST` | `/media/:id/retry` | 重试失败处理 |
| `DELETE` | `/media/:id` | 删除媒体对象 |

## 评论、举报和通知

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/features/:id/comments` | 创建待审核评论 |
| `PATCH` | `/comments/:id` | 15 分钟编辑窗口 |
| `DELETE` | `/comments/:id` | 删除评论 |
| `POST` | `/reports` | 举报内容或评论 |
| `GET` | `/me/notifications` | 通知列表 |
| `POST` | `/me/notifications/:id/read` | 标记已读 |

## 审核接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/moderation/queue` | 内容、评论、媒体和举报队列 |
| `POST` | `/moderation/features/:id/approve` | 批准内容或修订 |
| `POST` | `/moderation/features/:id/reject` | 拒绝 |
| `POST` | `/moderation/features/:id/request-changes` | 要求修改 |
| `POST` | `/moderation/features/:id/hide` | 隐藏 |
| `POST` | `/moderation/features/:id/restore` | 管理员恢复 |
| `POST` | `/moderation/comments/:id/approve` | 批准评论 |
| `POST` | `/moderation/comments/:id/reject` | 拒绝评论 |
| `POST` | `/moderation/comments/:id/hide` | 隐藏评论 |
| `POST` | `/moderation/reports/:id/resolve` | 处理举报 |
| `GET` | `/moderation/audit` | 管理员审计日志 |
