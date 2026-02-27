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
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`JSON Error: ${e.message}. Status: ${res.status}. Body: ${text.substring(0, 200)}`);
  }
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

/** 解析行内格式（粗体、斜体、删除线、行内代码、链接） */
function parseInlineElements(text: string): any[] {
  const elements: any[] = [];
  // 匹配: **bold**, *italic*, ~~strike~~, `code`, [text](url)
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // 前面的普通文本
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: text.substring(lastIndex, match.index) } });
    }

    if (match[2]) {
      // **bold**
      elements.push({ text_run: { content: match[2], text_element_style: { bold: true } } });
    } else if (match[3]) {
      // *italic*
      elements.push({ text_run: { content: match[3], text_element_style: { italic: true } } });
    } else if (match[4]) {
      // ~~strike~~
      elements.push({ text_run: { content: match[4], text_element_style: { strikethrough: true } } });
    } else if (match[5]) {
      // `code`
      elements.push({ text_run: { content: match[5], text_element_style: { inline_code: true } } });
    } else if (match[6] && match[7]) {
      // [text](url)
      elements.push({ text_run: { content: match[6], text_element_style: { link: { url: encodeURI(match[7]) } } } });
    }

    lastIndex = match.index + match[0].length;
  }

  // 剩余文本
  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.substring(lastIndex) } });
  }

  return elements.length > 0 ? elements : [{ text_run: { content: text } }];
}

/** 判断是否是 markdown 表格行（含 | 分隔） */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** 判断是否是表格分隔行（如 |---|---|） */
function isTableSeparator(line: string): boolean {
  return /^\s*\|[\s\-:|]+\|\s*$/.test(line);
}

/** 将 markdown 表格行集合转为代码块内容 */
function tableLinesToCodeBlock(tableLines: string[]): string {
  // 解析每行的单元格
  const rows = tableLines
    .filter(l => !isTableSeparator(l))
    .map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));

  if (rows.length === 0) return '';

  // 计算每列最大宽度
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    colWidths[c] = Math.max(...rows.map(r => (r[c] || '').length), 3);
  }

  // 格式化输出
  const output: string[] = [];
  rows.forEach((row, i) => {
    const cells = row.map((cell, c) => cell.padEnd(colWidths[c]));
    output.push('| ' + cells.join(' | ') + ' |');
    if (i === 0) {
      // 表头后加分隔线
      output.push('| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |');
    }
  });

  return output.join('\n');
}

function simpleMarkdownToBlocks(markdown: string): any[] {
  const blocks: any[] = [];
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  let codeContent = '';
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length > 0) {
      const content = tableLinesToCodeBlock(tableLines);
      if (content) {
        blocks.push({
          block_type: 14,
          code: { elements: [{ text_run: { content } }], language: 1 }
        });
      }
      tableLines = [];
    }
  };

  for (const line of lines) {
    // 代码块处理
    if (line.trim().startsWith('```')) {
      flushTable();
      if (inCodeBlock) {
        blocks.push({
          block_type: 14,
          code: { elements: [{ text_run: { content: codeContent.replace(/\n$/, '') } }], language: 1 }
        });
        inCodeBlock = false;
        codeContent = '';
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += line + '\n';
      continue;
    }

    // 表格行收集
    if (isTableRow(line)) {
      tableLines.push(line);
      continue;
    } else {
      flushTable();
    }

    const trimmed = line.trim();

    // 空行跳过
    if (!trimmed) continue;

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }

    // 标题
    if (trimmed.startsWith('# ')) {
      blocks.push({ block_type: 3, heading1: { elements: parseInlineElements(trimmed.substring(2)) } });
    } else if (trimmed.startsWith('## ')) {
      blocks.push({ block_type: 4, heading2: { elements: parseInlineElements(trimmed.substring(3)) } });
    } else if (trimmed.startsWith('### ')) {
      blocks.push({ block_type: 5, heading3: { elements: parseInlineElements(trimmed.substring(4)) } });
    }
    // 有序列表
    else if (/^\d+\.\s/.test(trimmed)) {
      const content = trimmed.replace(/^\d+\.\s/, '');
      blocks.push({ block_type: 13, ordered: { elements: parseInlineElements(content) } });
    }
    // 无序列表
    else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({ block_type: 12, bullet: { elements: parseInlineElements(trimmed.substring(2)) } });
    }
    // 引用
    else if (trimmed.startsWith('> ')) {
      blocks.push({ block_type: 15, quote: { elements: parseInlineElements(trimmed.substring(2)) } });
    }
    // TODO
    else if (/^- \[([ x])\]\s/.test(trimmed)) {
      const done = trimmed[3] === 'x';
      const content = trimmed.substring(6);
      blocks.push({ block_type: 17, todo: { elements: parseInlineElements(content), style: { done } } });
    }
    // 普通文本
    else {
      blocks.push({ block_type: 2, text: { elements: parseInlineElements(line) } });
    }
  }

  // 结尾清理
  flushTable();
  if (inCodeBlock && codeContent) {
    blocks.push({
      block_type: 14,
      code: { elements: [{ text_run: { content: codeContent.replace(/\n$/, '') } }], language: 1 }
    });
  }

  return blocks;
}

async function docWrite(docToken: string, markdown: string) {
  // 1. 转换 markdown 为 blocks (本地转换，不再依赖不稳定的 convert 接口)
  const blocks = simpleMarkdownToBlocks(markdown);

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
  const blocks = simpleMarkdownToBlocks(markdown);
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
//  Contact API
// ============================================================

async function contactSearch(query: string) {
  // 方案1: 尝试搜索 API (requires user_access_token, may fail with tenant_token)
  try {
    const data = await feishuPost('/open-apis/search/v1/user', { query });
    const users = (data?.users || []).map((u: any) => ({
      open_id: u.open_id,
      name: u.name,
      en_name: u.en_name,
      email: u.email,
      department: u.department_name,
    }));
    if (users.length > 0) return { users };
  } catch {}

  // 方案2: 逐部门查找（根部门 + 子部门递归）
  try {
    const allUsers: any[] = [];
    const seenIds = new Set<string>();
    const q = query.toLowerCase();

    // 先收集所有部门ID
    const deptIds: string[] = ['0'];
    const deptQueue: string[] = ['0'];

    // BFS 获取子部门（使用 children API 或 list API）
    while (deptQueue.length > 0 && deptIds.length < 200) {
      const parentId = deptQueue.shift()!;
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const params: Record<string, string> = {
          parent_department_id: parentId,
          page_size: '50',
          user_id_type: 'open_id',
          department_id_type: 'open_department_id',
          fetch_child: 'true',
        };
        if (pageToken) params.page_token = pageToken;
        try {
          const data = await feishuGet('/open-apis/contact/v3/departments', params);
          for (const dept of (data?.items || [])) {
            const id = dept.open_department_id;
            if (id && !deptIds.includes(id)) {
              deptIds.push(id);
            }
          }
          if (!data?.has_more) break;
          pageToken = data?.page_token;
        } catch { break; }
      }
    }

    // 逐部门查找用户
    for (const deptId of deptIds) {
      let pageToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const params: Record<string, string> = {
          department_id: deptId,
          page_size: '50',
          user_id_type: 'open_id',
        };
        if (deptId !== '0') params.department_id_type = 'open_department_id';
        if (pageToken) params.page_token = pageToken;
        let data: any;
        try {
          data = await feishuGet('/open-apis/contact/v3/users/find_by_department', params);
        } catch { break; }
        for (const u of (data?.items || [])) {
          if (!seenIds.has(u.open_id) &&
              ((u.name || '').toLowerCase().includes(q) || (u.en_name || '').toLowerCase().includes(q))) {
            seenIds.add(u.open_id);
            allUsers.push({
              open_id: u.open_id,
              name: u.name,
              en_name: u.en_name,
              email: u.email,
              department_ids: u.department_ids,
            });
          }
        }
        if (!data?.has_more) break;
        pageToken = data?.page_token;
      }
      if (allUsers.length >= 10) break;
    }

    return { users: allUsers, source: 'contact_directory' };
  } catch (e: any) {
    return { users: [], error: e.message };
  }
}

async function contactBatchGetId(emails?: string[], mobiles?: string[]) {
  const body: any = {};
  if (emails?.length) body.emails = emails;
  if (mobiles?.length) body.mobiles = mobiles;
  const data = await feishuPost('/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', body);
  return {
    email_users: data?.email_users || {},
    mobile_users: data?.mobile_users || {},
  };
}

async function contactGetUser(userId: string) {
  const data = await feishuGet(`/open-apis/contact/v3/users/${userId}`, { user_id_type: 'open_id' });
  const u = data?.user;
  return {
    open_id: u?.open_id,
    name: u?.name,
    en_name: u?.en_name,
    email: u?.email,
    mobile: u?.mobile,
    avatar: u?.avatar?.avatar_72,
    department_ids: u?.department_ids,
    status: u?.status,
  };
}

// ============================================================
//  Message API
// ============================================================

async function messageSend(receiveId: string, receiveIdType: string, msgType: string, content: any) {
  const data = await feishuPost(`/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    receive_id: receiveId,
    msg_type: msgType,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  });
  return {
    message_id: data?.message_id,
    create_time: data?.create_time,
  };
}

async function messageSendText(receiveId: string, receiveIdType: string, text: string) {
  return messageSend(receiveId, receiveIdType, 'text', JSON.stringify({ text }));
}

async function messageSendRichText(receiveId: string, receiveIdType: string, title: string, contentParts: any[][]) {
  const post = { zh_cn: { title, content: contentParts } };
  return messageSend(receiveId, receiveIdType, 'post', JSON.stringify(post));
}

async function messageSendBatch(receiveIds: string[], receiveIdType: string, msgType: string, content: any) {
  const results: any[] = [];
  for (const id of receiveIds) {
    try {
      const r = await messageSend(id, receiveIdType, msgType, content);
      results.push({ receiveId: id, success: true, message_id: r.message_id });
    } catch (e: any) {
      results.push({ receiveId: id, success: false, error: e.message });
    }
  }
  return { sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
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
  // 飞书插件 enabled 时它自己会注册工具，我们跳过避免冲突
  try {
    const config = api.config;
    const entries = config?.plugins?.entries || {};
    const feishuEntry = entries['feishu'] as any;
    // 飞书插件存在且未明确 disable → 它会注册工具，我们跳过
    if (feishuEntry && feishuEntry.enabled !== false) {
      logger.info('[feishu-tools] 检测到 OpenClaw 飞书插件已启用，跳过注册');
      return false;
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

  // ---- feishu_contact ----
  api.registerTool({
    name: 'feishu_contact',
    label: 'Feishu Contact',
    description: 'Feishu contact/user lookup. Actions: search (by name), batch_get_id (by emails/mobiles), get (by open_id). Use search to find a person\'s open_id by name.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'batch_get_id', 'get'], description: 'Action' },
        query: { type: 'string', description: 'Search keyword (name) for search action' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Email list for batch_get_id' },
        mobiles: { type: 'array', items: { type: 'string' }, description: 'Mobile list for batch_get_id' },
        user_id: { type: 'string', description: 'User open_id for get action' },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        switch (p.action) {
          case 'search': return json(await contactSearch(p.query));
          case 'batch_get_id': return json(await contactBatchGetId(p.emails, p.mobiles));
          case 'get': return json(await contactGetUser(p.user_id));
          default: return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_contact' });

  // ---- feishu_message ----
  api.registerTool({
    name: 'feishu_message',
    label: 'Feishu Message',
    description: 'Send Feishu messages. Actions: send (single), send_batch (multiple). Supports text and rich text. Use feishu_contact to look up open_id first if needed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'send_batch'], description: 'Action' },
        receive_id: { type: 'string', description: 'Recipient ID (open_id or email)' },
        receive_id_type: { type: 'string', enum: ['open_id', 'email', 'user_id', 'chat_id'], description: 'Recipient ID type (default: open_id)' },
        receive_ids: { type: 'array', items: { type: 'string' }, description: 'Multiple recipient IDs for send_batch' },
        msg_type: { type: 'string', enum: ['text', 'post'], description: 'Message type: text (plain) or post (rich text with links). Default: text' },
        text: { type: 'string', description: 'Message text content (for text type)' },
        title: { type: 'string', description: 'Rich text title (for post type)' },
        content: {
          type: 'array',
          description: 'Rich text content blocks (for post type). Array of lines, each line is array of elements like {tag:"text",text:"..."} or {tag:"a",text:"click",href:"https://..."}',
          items: { type: 'array', items: { type: 'object' } },
        },
      },
      required: ['action'],
    },
    async execute(_id: string, p: any) {
      try {
        const idType = p.receive_id_type || 'open_id';
        const msgType = p.msg_type || 'text';

        if (p.action === 'send') {
          if (msgType === 'text') {
            return json(await messageSendText(p.receive_id, idType, p.text));
          } else if (msgType === 'post') {
            return json(await messageSendRichText(p.receive_id, idType, p.title || '', p.content || []));
          } else {
            return json(await messageSend(p.receive_id, idType, msgType, p.text || p.content));
          }
        } else if (p.action === 'send_batch') {
          const ids = p.receive_ids || [];
          if (msgType === 'text') {
            const content = JSON.stringify({ text: p.text });
            return json(await messageSendBatch(ids, idType, 'text', content));
          } else if (msgType === 'post') {
            const post = { zh_cn: { title: p.title || '', content: p.content || [] } };
            return json(await messageSendBatch(ids, idType, 'post', JSON.stringify(post)));
          }
          return json({ error: 'Unsupported msg_type for batch' });
        }
        return json({ error: `Unknown action: ${p.action}` });
      } catch (err: any) { return json({ error: err.message }); }
    },
  }, { name: 'feishu_message' });

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
  logger.info('[feishu-tools] ✅ 已注册 7 个飞书工具（feishu_doc/wiki/drive/perm/contact/message/app_scopes）');
  return true;
}
