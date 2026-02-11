# Changelog

## [3.1.0] - 2026-02-11

### Added
- **Owner 身份自动下发** — 飞书用户 `/bind` 时自动将 open_id 写入集群共享配置，下发给所有节点
- 创建文档后自动给 owner 加 `full_access` 权限，无需 AI 手动操作
- 工具 description 注入 owner openId，AI 手动加权限时知道该加给谁
- `SharedConfig` 新增 `owner` 字段（openId + name）

## [3.0.0] - 2026-02-11

### Added
- **飞书工具自动下发** — Hub 自动将飞书凭据（appId/appSecret）下发给集群内节点，子节点无需单独配置即可获得飞书文档能力
- 新增 `feishu-tools.ts` — 轻量飞书 REST 客户端（不依赖 `@larksuiteoapi/node-sdk`），自动注册 5 个飞书工具：
  - `feishu_doc` — 文档读写（read/write/append/create/list_blocks/get_block/update_block/delete_block）
  - `feishu_wiki` — 知识库操作（spaces/nodes/get/create）
  - `feishu_drive` — 云空间管理（list/create_folder/move/delete）
  - `feishu_perm` — 权限管理（list/add/remove）
  - `feishu_app_scopes` — 查看应用权限
- 新增 RPC: `hub.shared-config.get` / `hub.shared-config.set` — 管理集群共享配置
- `hub-client.ts` 新增 `httpPut` 方法和 `onSharedConfig` 回调
- 智能冲突检测：如果 OpenClaw 已有飞书插件且已启用+有账号配置，自动跳过注册

### Changed
- Hub 服务端新增 `SharedConfig` 类型和集群共享配置存储（持久化）
- Hub 连接确认消息（`connected`）自动附带共享配置
- Hub 配置更新时实时推送给所有在线节点

## [2.0.0] - 2026-02-10

### Added
- 初始版本
- 跨网络节点协作（WebSocket + REST）
- 任务分发 + 批量并行 + 等待汇总
- 节点间聊天
- 树形集群结构（最大深度 5 层）
- 持久化存储（任务/聊天/节点事件）
- 18+ Gateway RPC 方法
- 7 个 AI 工具
- CLI 命令
- 飞书机器人集成
