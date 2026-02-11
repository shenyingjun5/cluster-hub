/**
 * 飞书工具集 — 轻量 REST 实现（不依赖 @larksuiteoapi/node-sdk）
 * 由 Hub 下发 appId/appSecret，自动注册 AI 工具
 */

// ============================================================
//  Feishu REST Client
// ============================================================

interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain?: string;
}

interface OwnerInfo {
  openId: string;
  name?: string;
}

let _credentials: FeishuCredentials | null = null;
let _owner: OwnerInfo | null = null;
let _tenantToken: string | null = null;
let _tokenExpiresAt = 0;

function getBaseUrl(domain?: string): string {
  if (domain === 'lark') return 'https://open.larksuite.com';
  if (domain && domain !== 'feishu') return domain.replace(/\/+$/, '');
  return 'https://open.feishu.cn';
}

export function setCredentials(creds: FeishuCredentials) {
  _credentials = creds;
  _tenantToken = null;
  _tokenExpiresAt = 0;
}

export function setOwner(owner: OwnerInfo | undefined) {
  if (owner?.openId) _owner = owner;
}

export function hasCredentials(): boolean {
  return !!_credentials?.appId && !!_credentials?.appSecret;
}

async function getTenantToken(): Promise<string> {
  if (!_credentials) throw new Error('飞书凭据未配置');

  if (_tenantToken && Date.now() < _tokenExpiresAt) {
    return _tenantToken;
  }

  const base = getBaseUrl(_credentials.domain);
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: _credentials.appId,
      app_secret: _credentials.appSecret,
    }),
  });

  const data = await res.json() as any;
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg}`);
  }

  _tenantToken = data.tenant_access_token;
  _tokenExpiresAt = Date.now() + (data.expire - 300) * 1000; // 提前5分钟刷新
  return _tenantToken!;
}

async function feishuGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getTenantToken();
  const base = getBaseUrl(_credentials?.domain);
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(data.msg || `API error ${data.code}`);
  return data.data;
}

async function feishuPost(path: string, body: any): Promise<any> {
  const token = await getTenantToken();
  const base = getBaseUrl(_credentials?.domain);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(data.msg || `API error ${data.code}`);
  return data.data;
}

async function feishuPatch(path: string, body: any): Promise<any> {
  const token = await getTenantToken();
  const base = getBaseUrl(_credentials?.domain);
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(data.msg || `API error ${data.code}`);
  return data.data;
}

async function feishuDelete(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getTenantToken();
  const base = getBaseUrl(_credentials?.domain);
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(data.msg || `API error ${data.code}`);
  return data.data;
}

async function feishuPut(path: string, body: any): Promise<any> {
  const token = await getTenantToken();
  const base = getBaseUrl(_credentials?.domain);
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(data.msg || `API error ${data.code}`);
  return data.data;
}

// ============================================================
//  Document API
// ============================================================

async function docRead(docToken: string) {
  const [content, info, blocks] = await Promise.all([
    feishuGet(`/open-apis/docx/v1/documents/${docToken}/raw_content`),
    feishuGet(`/open-apis/docx/v1/documents/${docToken}`),
    feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks`),
  ]);

  const BLOCK_TYPE_NAMES: Record<number, string> = {
    1: 'Page', 2: 'Text', 3: 'Heading1', 4: 'Heading2', 5: 'Heading3',
    12: 'Bullet', 13: 'Ordered', 14: 'Code', 15: 'Quote', 17: 'Todo',
    18: 'Bitable', 22: 'Divider', 27: 'Image', 31: 'Table',
  };
  const blockItems = blocks?.items || [];
  const blockCounts: Record<string, number> = {};
  for (const b of blockItems) {
    const name = BLOCK_TYPE_NAMES[b.block_type] || `type_${b.block_type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
  }

  return {
    title: info?.document?.title,
    content: content?.content,
    revision_id: info?.document?.revision_id,
    block_count: blockItems.length,
    block_types: blockCounts,
  };
}

async function docCreate(title: string, folderToken?: string) {
  const data = await feishuPost('/open-apis/docx/v1/documents', {
    title,
    folder_token: folderToken,
  });
  const doc = data?.document;
  const result: any = {
    document_id: doc?.document_id,
    title: doc?.title,
    url: `https://feishu.cn/docx/${doc?.document_id}`,
  };

  // 自动给 owner 加编辑权限
  if (_owner?.openId && doc?.document_id) {
    try {
      await permAdd(doc.document_id, 'docx', 'openid', _owner.openId, 'full_access');
      result.owner_permission = 'full_access';
    } catch (e: any) {
      result.owner_permission_error = e.message;
    }
  }

  return result;
}

async function docWrite(docToken: string, markdown: string) {
  // 1. 转换 markdown 为 blocks
  const converted = await feishuPost('/open-apis/docx/v1/documents/convert', {
    content_type: 'markdown',
    content: markdown,
  });
  const blocks = converted?.blocks || [];

  // 2. 清除现有内容
  const existing = await feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks`);
  const childIds = (existing?.items || [])
    .filter((b: any) => b.parent_id === docToken && b.block_type !== 1)
    .map((b: any) => b.block_id);

  if (childIds.length > 0) {
    await feishuDelete(`/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`, {
      start_index: '0',
      end_index: String(childIds.length),
    });
  }

  // 3. 插入新内容
  if (blocks.length === 0) {
    return { success: true, blocks_deleted: childIds.length, blocks_added: 0 };
  }

  const inserted = await feishuPost(
    `/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`,
    { children: blocks },
  );

  return {
    success: true,
    blocks_deleted: childIds.length,
    blocks_added: inserted?.children?.length || 0,
  };
}

async function docAppend(docToken: string, markdown: string) {
  const converted = await feishuPost('/open-apis/docx/v1/documents/convert', {
    content_type: 'markdown',
    content: markdown,
  });
  const blocks = converted?.blocks || [];
  if (blocks.length === 0) throw new Error('Content is empty');

  const inserted = await feishuPost(
    `/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`,
    { children: blocks },
  );

  return {
    success: true,
    blocks_added: inserted?.children?.length || 0,
  };
}

async function docListBlocks(docToken: string) {
  return await feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks`);
}

async function docGetBlock(docToken: string, blockId: string) {
  return await feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks/${blockId}`);
}

async function docUpdateBlock(docToken: string, blockId: string, content: string) {
  await feishuPatch(`/open-apis/docx/v1/documents/${docToken}/blocks/${blockId}`, {
    update_text_elements: {
      elements: [{ text_run: { content } }],
    },
  });
  return { success: true, block_id: blockId };
}

async function docDeleteBlock(docToken: string, blockId: string) {
  const blockInfo = await feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks/${blockId}`);
  const parentId = blockInfo?.block?.parent_id || docToken;
  const children = await feishuGet(`/open-apis/docx/v1/documents/${docToken}/blocks/${parentId}/children`);
  const items = children?.items || [];
  const index = items.findIndex((item: any) => item.block_id === blockId);
  if (index === -1) throw new Error('Block not found');

  await feishuDelete(`/open-apis/docx/v1/documents/${docToken}/blocks/${parentId}/children`, {
    start_index: String(index),
    end_index: String(index + 1),
  });
  return { success: true, deleted_block_id: blockId };
}

// ============================================================
//  Wiki API
// ============================================================

async function wikiSpaces() {
  const data = await feishuGet('/open-apis/wiki/v2/spaces');
  return {
    spaces: (data?.items || []).map((s: any) => ({
      space_id: s.space_id, name: s.name, description: s.description, visibility: s.visibility,
    })),
  };
}

async function wikiNodes(spaceId: string, parentNodeToken?: string) {
  const params: Record<string, string> = {};
  if (parentNodeToken) params.parent_node_token = parentNodeToken;
  const data = await feishuGet(`/open-apis/wiki/v2/spaces/${spaceId}/nodes`, params);
  return {
    nodes: (data?.items || []).map((n: any) => ({
      node_token: n.node_token, obj_token: n.obj_token, obj_type: n.obj_type,
      title: n.title, has_child: n.has_child,
    })),
  };
}

async function wikiGet(token: string) {
  const data = await feishuGet('/open-apis/wiki/v2/spaces/get_node', { token });
  const node = data?.node;
  return {
    node_token: node?.node_token, space_id: node?.space_id, obj_token: node?.obj_token,
    obj_type: node?.obj_type, title: node?.title, parent_node_token: node?.parent_node_token,
    has_child: node?.has_child,
  };
}

async function wikiCreate(spaceId: string, title: string, objType?: string, parentNodeToken?: string) {
  const data = await feishuPost(`/open-apis/wiki/v2/spaces/${spaceId}/nodes`, {
    obj_type: objType || 'docx', node_type: 'origin', title, parent_node_token: parentNodeToken,
  });
  const node = data?.node;
  return { node_token: node?.node_token, obj_token: node?.obj_token, title: node?.title };
}

// ============================================================
//  Drive API
// ============================================================

async function driveList(folderToken?: string) {
  const params: Record<string, string> = {};
  if (folderToken && folderToken !== '0') params.folder_token = folderToken;
  const data = await feishuGet('/open-apis/drive/v1/files', params);
  return {
    files: (data?.files || []).map((f: any) => ({
      token: f.token, name: f.name, type: f.type, url: f.url,
      created_time: f.created_time, modified_time: f.modified_time,
    })),
  };
}

async function driveCreateFolder(name: string, folderToken?: string) {
  const data = await feishuPost('/open-apis/drive/v1/files/create_folder', {
    name, folder_token: folderToken || '0',
  });
  return { token: data?.token, url: data?.url };
}

async function driveMove(fileToken: string, type: string, folderToken: string) {
  const data = await feishuPost(`/open-apis/drive/v1/files/${fileToken}/move`, {
    type, folder_token: folderToken,
  });
  return { success: true, task_id: data?.task_id };
}

async function driveDelete(fileToken: string, type: string) {
  const data = await feishuDelete(`/open-apis/drive/v1/files/${fileToken}`, { type });
  return { success: true, task_id: data?.task_id };
}

// ============================================================
//  Permission API
// ============================================================

async function permList(token: string, type: string) {
  const data = await feishuGet(`/open-apis/drive/v1/permissions/${token}/members`, { type });
  return {
    members: (data?.items || []).map((m: any) => ({
      member_type: m.member_type, member_id: m.member_id, perm: m.perm, name: m.name,
    })),
  };
}

async function permAdd(token: string, type: string, memberType: string, memberId: string, perm: string) {
  const data = await feishuPost(`/open-apis/drive/v1/permissions/${token}/members?type=${type}&need_notification=true`, {
    member_type: memberType, member_id: memberId, perm,
  });
  return { success: true, member: data?.member };
}

async function permRemove(token: string, type: string, memberType: string, memberId: string) {
  await feishuDelete(`/open-apis/drive/v1/permissions/${token}/members/${memberId}`, {
    type, member_type: memberType,
  });
  return { success: true };
}

// ============================================================
//  App Scopes API
// ============================================================

async function appScopes() {
  const data = await feishuGet('/open-apis/application/v6/scopes');
  const scopes = data?.scopes || [];
  const granted = scopes.filter((s: any) => s.grant_status === 1);
  const pending = scopes.filter((s: any) => s.grant_status !== 1);
  return {
    granted: granted.map((s: any) => ({ name: s.scope_name, type: s.scope_type })),
    pending: pending.map((s: any) => ({ name: s.scope_name, type: s.scope_type })),
    summary: `${granted.length} granted, ${pending.length} pending`,
  };
}

// ============================================================
//  Tool Registration
// ============================================================

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

let _registered = false;

export function isFeishuToolsRegistered(): boolean {
  return _registered;
}

export function registerFeishuTools(api: any, logger: any): boolean {
  if (_registered) {
    logger.info('[feishu-tools] 已注册，跳过');
    return false;
  }

  if (!hasCredentials()) {
    logger.info('[feishu-tools] 无飞书凭据，跳过');
    return false;
  }

  // 检测 OpenClaw 飞书插件是否已启用
  // 只有飞书插件 enabled 且有配置时才跳过；disabled 或不存在时正常注册
  try {
    const config = api.config;
    const entries = config?.plugins?.entries || {};
    const feishuEntry = entries['feishu'] as any;
    // 飞书插件存在且未明确 disable → 说明它会注册工具，我们跳过
    if (feishuEntry && feishuEntry.enabled !== false) {
      // 还要确认它有实际的飞书账号配置（有 appId），否则它也不会注册工具
      const accounts = feishuEntry.config?.accounts || feishuEntry.accounts;
      const hasAccount = Array.isArray(accounts) 
        ? accounts.some((a: any) => a.appId || a.config?.appId)
        : (feishuEntry.config?.appId || feishuEntry.appId);
      if (hasAccount) {
        logger.info('[feishu-tools] 检测到 OpenClaw 飞书插件已启用，跳过注册');
        return false;
      }
    }
  } catch {}

  // ---- feishu_doc ----
  const ownerHint = _owner?.openId
    ? ` Documents created via API are owned by the app bot. Owner (openid: ${_owner.openId}) is auto-granted full_access on create.`
    : '';

  api.registerTool({
    name: 'feishu_doc',
    label: 'Feishu Doc',
    description: `Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block.${ownerHint}`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'append', 'create', 'list_blocks', 'get_block', 'update_block', 'delete_block'], description: 'Action to perform' },
        doc_token: { type: 'string', description: 'Document token (from URL /docx/XXX)' },
        content: { type: 'string', description: 'Markdown content (for write/append/update_block)' },
        title: { type: 'string', description: 'Document title (for create)' },
        folder_token: { type: 'string', description: 'Target folder token (optional)' },
        block_id: { type: 'string', description: 'Block ID (for get_block/update_block/delete_block)' },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        switch (p.action) {
          case 'read': return json(await docRead(p.doc_token));
          case 'write': return json(await docWrite(p.doc_token, p.content));
          case 'append': return json(await docAppend(p.doc_token, p.content));
          case 'create': return json(await docCreate(p.title, p.folder_token));
          case 'list_blocks': return json(await docListBlocks(p.doc_token));
          case 'get_block': return json(await docGetBlock(p.doc_token, p.block_id));
          case 'update_block': return json(await docUpdateBlock(p.doc_token, p.block_id, p.content));
          case 'delete_block': return json(await docDeleteBlock(p.doc_token, p.block_id));
          default: return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_doc' });

  // ---- feishu_wiki ----
  api.registerTool({
    name: 'feishu_wiki',
    label: 'Feishu Wiki',
    description: 'Feishu knowledge base operations. Actions: spaces, nodes, get, create',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spaces', 'nodes', 'get', 'create'], description: 'Action' },
        space_id: { type: 'string', description: 'Knowledge space ID' },
        token: { type: 'string', description: 'Wiki node token (from URL /wiki/XXX)' },
        title: { type: 'string', description: 'Node title' },
        obj_type: { type: 'string', description: 'Object type (default: docx)' },
        parent_node_token: { type: 'string', description: 'Parent node token' },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        switch (p.action) {
          case 'spaces': return json(await wikiSpaces());
          case 'nodes': return json(await wikiNodes(p.space_id, p.parent_node_token));
          case 'get': return json(await wikiGet(p.token));
          case 'create': return json(await wikiCreate(p.space_id, p.title, p.obj_type, p.parent_node_token));
          default: return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_wiki' });

  // ---- feishu_drive ----
  api.registerTool({
    name: 'feishu_drive',
    label: 'Feishu Drive',
    description: 'Feishu cloud storage operations. Actions: list, create_folder, move, delete',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create_folder', 'move', 'delete'], description: 'Action' },
        folder_token: { type: 'string', description: 'Folder token' },
        file_token: { type: 'string', description: 'File token' },
        name: { type: 'string', description: 'Folder name (for create_folder)' },
        type: { type: 'string', description: 'File type (doc/docx/sheet/bitable/folder/file)' },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        switch (p.action) {
          case 'list': return json(await driveList(p.folder_token));
          case 'create_folder': return json(await driveCreateFolder(p.name, p.folder_token));
          case 'move': return json(await driveMove(p.file_token, p.type, p.folder_token));
          case 'delete': return json(await driveDelete(p.file_token, p.type));
          default: return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_drive' });

  // ---- feishu_perm ----
  const permOwnerHint = _owner?.openId
    ? ` Owner open_id: ${_owner.openId}`
    : '';

  api.registerTool({
    name: 'feishu_perm',
    label: 'Feishu Perm',
    description: `Feishu permission management. Actions: list, add, remove.${permOwnerHint}`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Action' },
        token: { type: 'string', description: 'File token' },
        type: { type: 'string', description: 'Token type (doc/docx/sheet/bitable/folder/file/wiki)' },
        member_type: { type: 'string', description: 'Member type (email/openid/userid)' },
        member_id: { type: 'string', description: 'Member ID' },
        perm: { type: 'string', description: 'Permission (view/edit/full_access)' },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        switch (p.action) {
          case 'list': return json(await permList(p.token, p.type));
          case 'add': return json(await permAdd(p.token, p.type, p.member_type, p.member_id, p.perm));
          case 'remove': return json(await permRemove(p.token, p.type, p.member_type, p.member_id));
          default: return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_perm' });

  // ---- feishu_app_scopes ----
  api.registerTool({
    name: 'feishu_app_scopes',
    label: 'Feishu App Scopes',
    description: 'List current Feishu app permissions (scopes).',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try { return json(await appScopes()); }
      catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_app_scopes' });

  _registered = true;
  logger.info('[feishu-tools] ✅ 已注册 5 个飞书工具（feishu_doc/wiki/drive/perm/app_scopes）');
  return true;
}
