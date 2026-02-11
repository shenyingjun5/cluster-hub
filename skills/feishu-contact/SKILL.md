---
name: feishu-contact
description: |
  Feishu contact/user lookup. Activate when user mentions finding someone, looking up a person, or needing someone's Feishu ID.
---

# Feishu Contact Tool

Single tool `feishu_contact` for looking up users in the organization directory.

## Actions

### Search by Name

```json
{ "action": "search", "query": "张三" }
```

Returns: `open_id`, `name`, `en_name`, `email`, `department`.

Tries search API first, falls back to directory listing + name filter. Works with partial names.

### Batch Get ID by Email

```json
{ "action": "batch_get_id", "emails": ["alice@company.com", "bob@company.com"] }
```

Returns mapping of emails to user IDs (`open_id`). Most reliable method when you have email addresses.

### Get User Details

```json
{ "action": "get", "user_id": "ou_xxxxx" }
```

Returns full user profile: name, email, mobile, department, status.

## Common Workflows

### Find someone and share a document

```
1. feishu_contact → search "张三" → open_id
2. feishu_perm → add with openid → done (auto-notifies)
```

### Find someone and send them a message

```
1. feishu_contact → search "张三" → open_id
2. feishu_message → send with open_id → done
```

### Send to multiple people

```
1. feishu_contact → search "张三" → open_id_A
2. feishu_contact → search "李四" → open_id_B
3. feishu_message → send_batch with [open_id_A, open_id_B] → done
```

## Tips

- **Email is fastest** — if you have the email, use `batch_get_id` instead of `search`
- **Name search** — supports partial match, case-insensitive
- **Multiple matches** — search may return multiple users; confirm with the human if ambiguous

## Permissions

Required scope: `contact:user.base:readonly`
