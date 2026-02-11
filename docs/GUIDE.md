# OpenClaw Hub 集群 — 新手安装指引

## 目录

- [前置条件](#前置条件)
- [第一步：安装插件](#第一步安装插件)
- [第二步：创建集群（根节点）](#第二步创建集群根节点)
- [第三步：添加子节点](#第三步添加子节点)
- [第四步：飞书机器人](#第四步飞书机器人)
- [AI 对话指令](#ai-对话指令)
- [CLI 命令速查](#cli-命令速查)
- [常见问题](#常见问题)

---

## 前置条件

- 已安装 [OpenClaw](https://github.com/openclaw/openclaw)
- OpenClaw Gateway 正常运行（`openclaw gateway status`）
- 有终端/命令行访问权限

---

## 第一步：安装插件

在终端执行：

```bash
# 克隆插件到 OpenClaw 插件目录
cd ~/.openclaw/extensions
git clone https://github.com/shenyingjun5/cluster-hub.git cluster-hub

# 重启 Gateway 加载插件
kill -9 $(pgrep -f "openclaw.*gateway")
openclaw gateway start
```

验证安装：

```bash
openclaw plugins list
# 应看到 cluster-hub 状态为 loaded
```

---

## 第二步：创建集群（根节点）

> 每个集群需要一个根节点作为管理者。一般由团队负责人创建。

### 2.1 注册根节点

```bash
openclaw hub register --name "我的Mac" --alias home
```

- `--name`：节点显示名称（支持中文）
- `--alias`：节点别名，集群内唯一，用于 `#别名` 提及

注册成功后会输出：

```
✅ 注册成功! 节点 ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  WebSocket: 已连接
```

配置自动写入 `~/.openclaw/openclaw.json`，无需手动修改。

### 2.2 生成邀请码

根节点创建后，生成邀请码供其他人加入：

```bash
openclaw hub invite --new
```

输出示例：

```
✅ 新邀请码: K2XPWV

子节点加入命令:
  openclaw hub register --parent xxxxxxxx --invite K2XPWV --name "节点名" --alias "别名"
```

**把这条命令发给要加入集群的人即可。**

### 2.3 查看当前邀请码

```bash
openclaw hub invite
```

---

## 第三步：添加子节点

> 每个想加入集群的人在自己的电脑上操作。

### 3.1 安装插件（同第一步）

```bash
cd ~/.openclaw/extensions
git clone https://github.com/shenyingjun5/cluster-hub.git cluster-hub
kill -9 $(pgrep -f "openclaw.*gateway")
openclaw gateway start
```

### 3.2 用邀请码注册

使用根节点管理者提供的命令：

```bash
openclaw hub register --parent <父节点ID> --invite <邀请码> --name "办公室Mac" --alias office
```

注册成功后自动连接。

### 3.3 验证连接

```bash
openclaw hub status
```

应看到 `WebSocket: 已连接`，以及集群中的其他节点。

---

## 第四步：飞书机器人

通过飞书机器人「进宝」，可以直接在飞书里和集群中的任意节点对话。

### 4.1 添加机器人

在飞书中搜索并添加「进宝」机器人为好友。

### 4.2 绑定集群

首次给进宝发消息时，会收到欢迎卡片。发送绑定命令：

```
/bind <你的根节点ID>
```

绑定成功后就可以开始使用了。

### 4.3 聊天

发消息给进宝即可和默认节点对话：

```
你好，帮我查一下系统状态
```

### 4.4 指定节点

用 `#别名` 前缀指定目标节点：

```
#home 检查磁盘空间
#office 运行 npm test
```

### 4.5 广播

`#all` 同时发给集群所有在线节点：

```
#all 报告系统负载
```

每个节点会单独回复。

### 4.6 切换默认节点

```
#home
```

只发 `#别名` 不跟文字，切换后续消息的默认目标。

### 4.7 机器人命令

| 命令 | 说明 |
|------|------|
| `/list` | 查看集群所有节点 |
| `/status` | 查看集群状态 |
| `/tasks` | 查看任务列表 |
| `/who` | 当前默认对话节点 |
| `/info` | 绑定信息 |
| `/bind <ID>` | 绑定集群 |
| `/unbind` | 解除绑定 |
| `/help` | 帮助 |

---

## AI 对话指令

安装插件后，你的 OpenClaw AI 自动获得集群能力。以下是常用的自然语言指令：

### 状态查询

| 你说 | AI 做什么 |
|------|-----------|
| "查看集群状态" | 显示 Hub 连接状态、在线节点数 |
| "列出所有节点" | 显示每个节点的名称、别名、在线状态 |
| "查看任务列表" | 显示任务队列和历史 |

### 任务下发

| 你说 | AI 做什么 |
|------|-----------|
| "让 macAir 检查磁盘空间" | 给 macAir 节点发任务 |
| "给 office 执行 npm test" | 给 office 节点发任务 |
| "给所有节点发送'报告系统负载'" | 批量下发到所有子节点 |

### 任务编排（高级）

| 你说 | AI 做什么 |
|------|-----------|
| "让 home 写代码，macAir 负责测试" | 分解任务 → 分发到不同节点 → 等待汇总 |
| "同时让三个节点各自检查安全更新" | 并行下发 → 等待全部完成 → 汇总结果 |
| "先让 gpu-server 训练模型，完成后让 home 分析结果" | 串行编排（Pipeline 模式） |

### 邀请码管理

| 你说 | AI 做什么 |
|------|-----------|
| "查看邀请码" | 显示当前邀请码 |
| "生成新邀请码" | 创建新的邀请码 |

---

## CLI 命令速查

```bash
# 状态
openclaw hub status          # 连接状态 + 节点列表
openclaw hub nodes           # 所有节点详情
openclaw hub tree            # 树形结构

# 注册
openclaw hub register        # 注册为根节点
openclaw hub register --parent <ID> --invite <码>  # 注册为子节点
openclaw hub unregister      # 注销

# 邀请码
openclaw hub invite          # 查看邀请码
openclaw hub invite --new    # 生成新邀请码

# 任务
openclaw hub send <别名> "指令"   # 发送任务
openclaw hub tasks           # 查看任务

# 连接
openclaw hub connect         # 手动连接
openclaw hub disconnect      # 断开连接
```

---

## 常见问题

### Q: 注册时提示 "别名已被使用"

别名在集群内必须唯一。换一个别名，或联系管理员清除旧节点。

### Q: 显示已注册但 WebSocket 未连接

```bash
# 完全重启 Gateway
kill -9 $(pgrep -f "openclaw.*gateway")
openclaw gateway start
```

### Q: 插件更新后命令没变化

必须 `kill -9` 完全重启 Gateway，普通重启不会重新加载插件代码。

```bash
# 更新插件
cd ~/.openclaw/extensions/cluster-hub && git pull

# 完全重启
kill -9 $(pgrep -f "openclaw.*gateway")
openclaw gateway start
```

### Q: 子节点无法给父节点发任务

这是设计如此。任务下发只能从父到子。节点间聊天（通过飞书机器人）不受此限制。

### Q: 飞书机器人没有回复

1. 确认已执行 `/bind`
2. 确认目标节点在线（`/list` 查看）
3. 目标节点的 Gateway 必须在运行
