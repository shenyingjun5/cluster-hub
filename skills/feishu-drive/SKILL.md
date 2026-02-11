---
name: feishu-drive
description: |
  Feishu cloud storage file management. Activate when user mentions cloud space, folders, drive, or file management.
---

# Feishu Drive Tool

Single tool `feishu_drive` for cloud storage operations.

## Actions

### List Files

```json
{ "action": "list" }
```

With specific folder: `{ "action": "list", "folder_token": "fldcnXXX" }`

Omit `folder_token` or use `"0"` for root directory.

### Create Folder

```json
{ "action": "create_folder", "name": "My Folder" }
```

With parent: `{ "action": "create_folder", "name": "My Folder", "folder_token": "fldcnXXX" }`

### Move File

```json
{ "action": "move", "file_token": "doxcnXXX", "type": "docx", "folder_token": "fldcnXXX" }
```

Types: `doc`, `docx`, `sheet`, `bitable`, `folder`, `file`

### Delete File

```json
{ "action": "delete", "file_token": "doxcnXXX", "type": "docx" }
```

## Permissions

Required scope: `drive:drive`
