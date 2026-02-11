---
name: feishu-message
description: |
  Send Feishu messages to users. Activate when user wants to send messages, notify someone, or share links via Feishu.
---

# Feishu Message Tool

Single tool `feishu_message` for sending messages to Feishu users.

## Actions

### Send Text Message

```json
{
  "action": "send",
  "receive_id": "ou_xxxxx",
  "receive_id_type": "open_id",
  "msg_type": "text",
  "text": "Hello!"
}
```

By email (no need to look up open_id):

```json
{
  "action": "send",
  "receive_id": "user@company.com",
  "receive_id_type": "email",
  "msg_type": "text",
  "text": "Hello!"
}
```

### Send Rich Text (with links)

```json
{
  "action": "send",
  "receive_id": "ou_xxxxx",
  "receive_id_type": "open_id",
  "msg_type": "post",
  "title": "Document Ready",
  "content": [
    [
      { "tag": "text", "text": "Your document is ready: " },
      { "tag": "a", "text": "Click to open", "href": "https://feishu.cn/docx/xxx" }
    ],
    [
      { "tag": "text", "text": "Please review and provide feedback." }
    ]
  ]
}
```

Rich text `content` is an array of lines. Each line is an array of elements:
- `{ "tag": "text", "text": "plain text" }` — plain text
- `{ "tag": "a", "text": "label", "href": "https://..." }` — hyperlink
- `{ "tag": "at", "user_id": "ou_xxx" }` — @ mention

### Batch Send

```json
{
  "action": "send_batch",
  "receive_ids": ["ou_aaa", "ou_bbb", "ou_ccc"],
  "receive_id_type": "open_id",
  "msg_type": "text",
  "text": "Team meeting in 10 minutes"
}
```

Returns success/failure count per recipient.

## Common Workflows

### Share document with message

```
1. feishu_doc → create document
2. feishu_doc → write content
3. feishu_perm → add permission for recipient (auto-notifies)
4. feishu_message → send rich text with document link
```

### Notify multiple people

```
1. feishu_contact → search each name → collect open_ids
2. feishu_message → send_batch with all open_ids
```

## Tips

- **Use email** as `receive_id_type` when possible — avoids the lookup step
- **Rich text** (`post`) is better for sharing links — they're clickable
- **Batch send** sends individually to each recipient (not a group chat)
- Messages are sent **as the bot** (app identity), not as the user

## Permissions

Required scope: `im:message`
