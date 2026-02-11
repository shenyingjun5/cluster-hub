---
name: feishu-doc
description: |
  Feishu document read/write operations. Activate when user mentions Feishu docs, cloud docs, or docx links.
---

# Feishu Document Tool

Single tool `feishu_doc` with action parameter for all document operations.

## Token Extraction

From URL `https://xxx.feishu.cn/docx/ABC123def` → `doc_token` = `ABC123def`

## Actions

### Read Document

```json
{ "action": "read", "doc_token": "ABC123def" }
```

Returns: title, plain text content, block count and types. Use `list_blocks` for structured content (tables, images).

### Write Document (Replace All)

```json
{ "action": "write", "doc_token": "ABC123def", "content": "# Title\n\nMarkdown content..." }
```

Replaces entire document with markdown. Supports: headings, lists, code blocks, quotes, links, bold/italic/strikethrough.

**⚠️ Markdown tables are NOT supported by Feishu.** Convert tables to bullet lists:

```markdown
❌ Wrong:
| Name | Role |
|------|------|
| Alice | Dev |

✅ Right:
- **Alice** — Dev
- **Bob** — PM
```

### Append Content

```json
{ "action": "append", "doc_token": "ABC123def", "content": "Additional content" }
```

### Create Document

```json
{ "action": "create", "title": "New Document" }
```

With folder: `{ "action": "create", "title": "New Document", "folder_token": "fldcnXXX" }`

**Note:** Documents created via API are owned by the bot app. Owner is auto-granted `full_access` if configured via Hub shared config.

### Block Operations

```json
{ "action": "list_blocks", "doc_token": "ABC123def" }
{ "action": "get_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
{ "action": "update_block", "doc_token": "ABC123def", "block_id": "doxcnXXX", "content": "New text" }
{ "action": "delete_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
```

## Reading Workflow

1. Start with `action: "read"` — get plain text + statistics
2. Check `block_types` for Table, Image, Code, etc.
3. If structured content exists, use `action: "list_blocks"` for full data

## Sharing Workflow

1. `feishu_doc` → `create` to create document
2. `feishu_doc` → `write` to fill content
3. `feishu_perm` → `add` to grant access (auto-notifies recipient)
4. Optionally `feishu_message` → `send` to notify with link

## Permissions

Required scope: `docx:document`, `drive:drive`
