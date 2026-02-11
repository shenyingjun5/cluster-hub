/**
 * cluster-hub 插件类型定义
 */

// ============================================================================
// 配置
// ============================================================================

export interface HubPluginConfig {
  hubUrl: string;
  adminKey?: string;
  nodeId?: string;
  nodeName?: string;
  nodeAlias?: string;
  token?: string;
  clusterId?: string;
  parentId?: string | null;
  capabilities: string[];
  heartbeatIntervalMs: number;
  reconnectIntervalMs: number;
  taskTimeoutMs: number;
  autoConnect: boolean;
  /** 自发任务模式: "local"=本地短路(默认), "hub"=走Hub路由 */
  selfTaskMode: 'local' | 'hub';
}

export const DEFAULT_CONFIG: HubPluginConfig = {
  hubUrl: 'https://openclaw-hub.hpplay.com.cn',
  capabilities: ['coding', 'shell'],
  heartbeatIntervalMs: 30000,
  reconnectIntervalMs: 5000,
  taskTimeoutMs: 300000,
  autoConnect: true,
  selfTaskMode: 'local',
};

// ============================================================================
// Hub 节点
// ============================================================================

export interface HubNode {
  id: string;
  name: string;
  alias: string;
  parentId: string | null;
  clusterId: string;
  depth: number;
  childIds: string[];
  capabilities: string[];
  online: boolean;
  load: number;
  connectedAt: number;
  lastHeartbeat: number;
  activeTasks: number;
  os?: string;
  arch?: string;
  version?: string;
}

export interface HubCluster {
  id: string;
  name: string;
  rootNodeId: string;
  nodeCount: number;
  createdAt: number;
}

export interface HubTreeNode {
  id: string;
  name: string;
  alias: string;
  online: boolean;
  load: number;
  capabilities: string[];
  depth: number;
  children: HubTreeNode[];
}

// ============================================================================
// Hub 注册
// ============================================================================

export interface RegisterRequest {
  id?: string;
  name: string;
  alias: string;
  parentId?: string | null;
  inviteCode?: string;
  capabilities?: string[];
}

export interface RegisterResponse {
  nodeId: string;
  clusterId: string;
  parentId: string | null;
  depth: number;
  token: string;
}

// ============================================================================
// WebSocket 消息
// ============================================================================

export type WSMessageType = 'task' | 'result' | 'task_ack' | 'task_status' | 'task_cancel' | 'chat' | 'direct' | 'broadcast' | 'heartbeat' | 'subscribe';

export interface WSMessage {
  type: WSMessageType;
  id: string;
  from?: string;
  to?: string;
  channel?: string;
  payload: any;
  timestamp?: number;
}

export interface TaskPayload {
  task: string;
  requirements?: string[];
  attachments?: any[];
  priority?: 'high' | 'normal' | 'low';
}

export interface ResultPayload {
  success: boolean;
  result?: string;
  error?: string;
}

// ============================================================================
// 插件运行时状态
// ============================================================================

export interface InteractiveMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  status: 'sending' | 'running' | 'completed' | 'failed' | 'timeout';
  taskId?: string;
}

export interface PendingTask {
  taskId: string;
  nodeId: string;
  instruction: string;
  createdAt: number;
  timeoutMs: number;
  resolve: (result: ResultPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// 任务系统 v2
// ============================================================================

/** 父节点追踪的任务 */
export interface TrackedTask {
  taskId: string;
  nodeId: string;
  instruction: string;
  status: 'sent' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  sentAt: number;
  ackedAt?: number;
  startedAt?: number;
  completedAt?: number;
  queuePosition?: number;
  result?: string;
  error?: string;
}

/** 子节点队列中的任务 */
export interface QueuedTask {
  taskId: string;
  fromNodeId: string;
  instruction: string;
  priority: 'high' | 'normal' | 'low';
  receivedAt: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: number;
  completedAt?: number;
  sessionKey?: string;
  result?: string;
  error?: string;
}

/** 节点任务统计 */
export interface NodeTaskStats {
  nodeId: string;
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  tasks: TrackedTask[];
}

// ============================================================================
// 持久化数据模型（v3 — 插件持久化一切，控制台只做呈现）
// ============================================================================

/** 持久化任务记录 — 一次指令来回 */
export interface StoredTask {
  taskId: string;
  targetNodeId: string;
  targetNodeName?: string;
  instruction: string;
  status: 'sent' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  sentAt: number;
  ackedAt?: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  source: 'local' | 'remote';
  durationMs?: number;
}

/** 接收到的任务（子节点持久化） */
export interface ReceivedTask {
  taskId: string;
  fromNodeId: string;
  fromNodeName?: string;
  instruction: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  receivedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  durationMs?: number;
}

/** 持久化聊天消息 */
export interface StoredChatMessage {
  id: string;
  nodeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** 持久化节点事件 */
export interface StoredNodeEvent {
  nodeId: string;
  nodeName?: string;
  event: 'online' | 'offline' | 'registered' | 'departed';
  timestamp: number;
}

// ============================================================================
// 远程聊天（子节点侧配置）
// ============================================================================

/** 聊天传输配置 */
export interface ChatConfig {
  /** 完整模式：true=返回 thinking+tool+text，false=只返回 text */
  whole: boolean;
  /** 定时轮询间隔(ms)，null=不开启定时轮询 */
  autoRefreshMs: number | null;
}
