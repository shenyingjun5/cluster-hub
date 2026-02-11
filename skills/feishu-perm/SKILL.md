---
name: feishu-perm
description: |
  Feishu permission management for documents and files. Activate when user mentions sharing, permissions, collaborators, or access control.
---

# Feishu Permission Tool

Single tool `feishu_perm` for managing document/file permissions.

## Actions

### List Collaborators

```json
{ "action": "list", "token": "doxcnXXX", "type": "docx" }
```

### Add Permission

```json
{
  "action": "add",
  "token": "doxcnXXX",
  "type": "docx",
  "member_type": "email",
  "member_id": "user@company.com",
  "perm": "edit"
}
```

**Member types (prefer email — most intuitive):**
- `email` — user's email address ✅ recommended
- `openid` — Feishu open_id (use `feishu_contact` to look up)
- `userid` — Feishu user_id

**Permission levels:**
- `view` — read only
- `edit` — can edit
- `full_access` — full control (can share, delete)

**Notification:** Adding permission automatically notifies the person on Feishu with a document link.

### Remove Permission

```json
{
  "action": "remove",
  "token": "doxcnXXX",
  "type": "docx",
  "member_type": "email",
  "member_id": "user@company.com"
}
```

## Token Types

| type | Description |
|------|-------------|
| `docx` | New format document |
| `doc` | Old format document |
| `sheet` | Spreadsheet |
| `bitable` | Multidimensional table |
| `folder` | Folder |
| `file` | Uploaded file |
| `wiki` | Wiki page |

## Share Document Workflow

To share a document with someone by name:

1. `feishu_contact` → `search` with name → get `open_id`
2. `feishu_perm` → `add` with `member_type: "openid"`, `member_id: open_id`

Or simply by email:

1. `feishu_perm` → `add` with `member_type: "email"`, `member_id: "user@company.com"`

## Permissions

Required scope: `drive:drive`
