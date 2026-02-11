# OpenClaw Hub CLI 命令参考

所有命令以 `openclaw hub` 开头。

## 命令列表

| 命令 | 说明 |
|------|------|
| `openclaw hub status` | 查看 Hub 连接和集群状态 |
| `openclaw hub nodes` | 列出所有节点（表格形式） |
| `openclaw hub tree` | 显示节点树形结构 |
| `openclaw hub register` | 注册本节点到 Hub |
| `openclaw hub unregister` | 从 Hub 注销节点 |
| `openclaw hub send` | 给节点发送指令/任务 |
| `openclaw hub tasks` | 查看任务列表 |
| `openclaw hub connect` | 手动连接 Hub |
| `openclaw hub disconnect` | 断开 Hub 连接 |
| `openclaw hub help` | 列出所有可用命令 |

---

## 详细说明

### `openclaw hub status`

查看 Hub 连接状态、注册状态、自发任务模式、任务统计和在线节点。

```bash
openclaw hub status
```

输出示例：
```
📡 Hub 集群状态

  连接:     ✅ 已连接
  注册:     ✅ 已注册
  节点:     16578344-4e63-442e-930a-2090a1f6cc13
  自发任务: 🏠 本地模式
  任务:     0 进行中, 3 完成, 0 失败

  节点列表 (2):
    🟢 招财Mac (@home) [coding,shell] load=0%
    ⚫ 办公室Mac (@office) [coding,shell] load=0%
```

---

### `openclaw hub nodes`

以表格形式列出集群中所有节点的详细信息。

```bash
openclaw hub nodes
```

显示字段：id、name、alias、online、parent、load、capabilities

---

### `openclaw hub tree`

以树形结构显示本集群的节点层级关系。

```bash
openclaw hub tree
```

输出示例：
```
└── 🟢 招财Mac (@home)
    ├── 🟢 办公室Mac (@office)
    └── ⚫ 树莓派 (@rpi)
```

---

### `openclaw hub register`

注册本节点到 Hub 集群。注册成功后 `nodeId`、`token`、`clusterId` 自动写入配置。

```bash
# 注册为根节点（创建新集群）
openclaw hub register --name "我的Mac" --alias "home"

# 注册为子节点（加入已有集群）
openclaw hub register --name "办公室Mac" --alias "office" --parent <父节点ID>
```

**参数：**

| 参数 | 说明 |
|------|------|
| `--name <name>` | 节点显示名称 |
| `--alias <alias>` | 节点别名（同集群内唯一，用于 @提及） |
| `--parent <parentId>` | 父节点 ID（不填则创建新集群为根节点） |

> ⚠️ 别名（alias）在同一集群中必须唯一，否则注册会失败（`ALIAS_CONFLICT`）。

---

### `openclaw hub unregister`

从 Hub 注销节点，清除注册信息。

```bash
# 注销自己
openclaw hub unregister

# 注销指定节点
openclaw hub unregister --node <nodeId>
```

**参数：**

| 参数 | 说明 |
|------|------|
| `--node <nodeId>` | 指定要注销的节点 ID（默认注销自己） |

---

### `openclaw hub send <nodeId> <instruction>`

给指定节点发送任务指令。

```bash
# 发送任务给子节点
openclaw hub send <nodeId> "检查磁盘空间"

# 自发本地任务（selfTaskMode=local 时同步等结果）
openclaw hub send <自己的nodeId> "执行 ls -la"

# 指定超时
openclaw hub send <nodeId> "编译项目" --timeout 600000
```

**参数：**

| 参数 | 说明 |
|------|------|
| `<nodeId>` | 目标节点 ID（必填） |
| `<instruction>` | 任务指令内容（必填） |
| `--timeout <ms>` | 超时毫秒数（默认 300000 = 5分钟） |

---

### `openclaw hub tasks`

查看任务列表（表格形式），显示任务 ID、目标节点、状态、指令摘要和耗时。

```bash
# 查看最近任务
openclaw hub tasks

# 指定数量
openclaw hub tasks --limit 50
```

**参数：**

| 参数 | 说明 |
|------|------|
| `--limit <n>` | 显示数量（默认 20） |

---

### `openclaw hub connect`

手动连接到 Hub WebSocket。通常不需要手动调用（`autoConnect: true` 时自动连接）。

```bash
openclaw hub connect
```

---

### `openclaw hub disconnect`

手动断开 Hub WebSocket 连接。

```bash
openclaw hub disconnect
```

---

### `openclaw hub help`

列出所有可用的 hub 子命令。

```bash
openclaw hub help
# 或
openclaw hub --help
```

---

## AI 工具

除 CLI 外，插件还注册了以下 AI 工具，可在对话中自然调用：

| 工具 | 说明 | 使用方式 |
|------|------|----------|
| `hub_status` | 查看集群状态 | "查看 Hub 状态" |
| `hub_nodes` | 列出所有节点 | "列出 Hub 节点" |
| `hub_send` | 发送任务（单个） | "让 @home 执行 xxx" |
| `hub_batch_send` | 批量下发任务（并行） | "同时让三个节点分别执行..." |
| `hub_wait_task` | 等待单个任务完成 | "等任务 xxx 完成后告诉我结果" |
| `hub_wait_all` | 等待多个任务全部完成 | "等所有任务完成后汇总" |
| `hub_tasks` | 查看任务进度 | "看看 Hub 任务进度" |

---

## Gateway RPC

插件注册的所有 Gateway RPC 方法（供控制台/程序调用）：

### 状态与连接
| RPC | 说明 |
|-----|------|
| `hub.status` | 获取整体状态（连接、节点列表、任务摘要） |
| `hub.connect` | 手动连接 Hub |
| `hub.disconnect` | 断开连接 |
| `hub.ping` | 检查连通性 |
| `hub.config.get` | 获取当前配置 |
| `hub.config.set` | 更新配置 |

### 节点管理
| RPC | 参数 | 说明 |
|-----|------|------|
| `hub.nodes` | — | 获取所有节点列表 |
| `hub.node.get` | `nodeId` | 获取单个节点信息 |
| `hub.node.update` | `nodeId, name?, alias?` | 更新节点名称/别名 |
| `hub.tree` | `nodeId?` | 获取树形结构 |
| `hub.children` | `nodeId?` | 获取直接子节点 |
| `hub.clusters` | — | 获取集群列表 |
| `hub.register` | `name, alias, parentId?, capabilities?` | 注册节点 |
| `hub.register.child` | `name, alias, parentId?, capabilities?` | 注册子节点 |
| `hub.unregister` | `nodeId?` | 注销节点 |
| `hub.reparent` | `nodeId, newParentId` | 变更父节点 |

### 邀请码
| RPC | 说明 |
|-----|------|
| `hub.invite-code.get` | 获取当前邀请码 |
| `hub.invite-code.set` | 设置/刷新邀请码（可选 `code` 参数） |

### 任务系统
| RPC | 参数 | 说明 |
|-----|------|------|
| `hub.task.send` | `nodeId, instruction` | 发送任务（异步） |
| `hub.task.batch` | `tasks: [{nodeId, instruction}]` | 批量下发任务（并行） |
| `hub.task.list` | `nodeId?, status?, limit?` | 获取任务列表 |
| `hub.task.get` | `taskId` | 获取单个任务 |
| `hub.task.cancel` | `taskId` | 取消任务 |
| `hub.task.clear` | `before?` | 清理已完成任务 |

### 远程聊天
| RPC | 参数 | 说明 |
|-----|------|------|
| `hub.chat.send` | `nodeId, content, whole?, autoRefreshMs?` | 发送聊天消息 |
| `hub.chat.history` | `nodeId, limit?` | 获取聊天记录 |
| `hub.chat.list` | — | 获取活跃聊天节点列表 |
| `hub.chat.clear` | `nodeId` | 清除聊天记录 |

### 节点事件
| RPC | 说明 |
|-----|------|
| `hub.node.events` | 获取节点上下线事件记录 |

### 兼容旧接口
| RPC | 说明 |
|-----|------|
| `hub.send` | → `hub.task.send` |
| `hub.send.sync` | 自发本地同步执行 |
| `hub.tasks` | → `hub.task.list` + 队列状态 |
| `hub.messages` | 获取消息历史 |
| `hub.messages.clear` | 清除消息 |
