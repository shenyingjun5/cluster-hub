---
name: feishu-wiki
description: |
  Feishu knowledge base navigation. Activate when user mentions knowledge base, wiki, or wiki links.
---

# Feishu Wiki Tool

Single tool `feishu_wiki` for knowledge base operations.

## Token Extraction

From URL `https://xxx.feishu.cn/wiki/ABC123def` → `token` = `ABC123def`

**Important:** Wiki node token ≠ document token. Use `feishu_wiki` → `get` to resolve wiki token to `obj_token`, then use `feishu_doc` with `obj_token` to read/write content.

## Actions

### List Knowledge Spaces

```json
{ "action": "spaces" }
```

If no spaces returned, the bot hasn't been added to any wiki space. Hint: Open wiki space → Settings → Members → Add the bot.

### List Nodes in Space

```json
{ "action": "nodes", "space_id": "7xxx" }
```

With parent: `{ "action": "nodes", "space_id": "7xxx", "parent_node_token": "wikcnXXX" }`

### Get Node Info

```json
{ "action": "get", "token": "ABC123def" }
```

Returns: `node_token`, `obj_token`, `obj_type`, `title`, `space_id`, `parent_node_token`.

### Create Node

```json
{ "action": "create", "space_id": "7xxx", "title": "New Page" }
```

With parent and type: `{ "action": "create", "space_id": "7xxx", "title": "Sheet", "obj_type": "sheet", "parent_node_token": "wikcnXXX" }`

Supported `obj_type`: `docx` (default), `sheet`, `bitable`.

## Reading Wiki Content Workflow

1. `feishu_wiki` → `get` with wiki token → get `obj_token`
2. `feishu_doc` → `read` with `obj_token` as `doc_token` → get content

## Writing Wiki Content Workflow

1. `feishu_wiki` → `get` with wiki token → get `obj_token`
2. `feishu_doc` → `write` with `obj_token` as `doc_token` → write content

## Permissions

Required scope: `wiki:wiki`

**⚠️ Common issue:** The bot must be added as a wiki space member to access it. Without this, all operations return permission errors.
