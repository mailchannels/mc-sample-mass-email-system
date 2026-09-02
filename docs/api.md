# HTTP API

All routes except `POST /webhooks/mailchannels` require Cloudflare Access. JSON endpoints are rooted at `/api`.

## Templates

- `GET /templates`
- `POST /templates` — `{ "name", "subject", "text", "html" }`
- `GET /templates/{name}`
- `PUT /templates/{name}` — `{ "subject", "text", "html" }`
- `DELETE /templates/{name}`

Content is stored in D1 and sent inline with `template_type: "mustache"`. Recipient CSV fields become `dynamic_template_data`.

## Recipient lists

- `GET /recipients-lists`
- `GET /generate-upload-url?filename=customers.csv&name=Customers`
- `PUT /uploads/{ticket}` — raw CSV body
- `DELETE /recipients-lists/{id}`
- `GET /topics`

The upload-ticket response contains `uploadUrl`, `method: "PUT"`, `expiresIn`, and `resourceId`. Tickets are single-use and expire in 15 minutes.

## Attachments

- `GET /attachments`
- `POST /attachments/upload-url` — `{ "filename", "contentType" }`
- `PUT /uploads/{ticket}` — raw attachment body
- `DELETE /attachments/{id}`

Uploads are private R2 objects. The send Worker base64-encodes them into MailChannels attachment objects. Inline images can be supported by populating `attachments.content_id`; the initial console treats uploads as ordinary attachments.

## Campaigns

- `GET /campaigns?limit=50&cursor={created_at}`
- `POST /campaigns`
- `GET /campaigns/{id}?limit=50&cursor={recipient_id}&search={email}`
- `PUT /campaigns/{id}` — `{ "name": "New display name" }`

Launch body:

```json
{
  "name": "September update",
  "recipientListId": "list_...",
  "templateName": "product-update",
  "senderEmail": "news@example.com",
  "senderName": "AnyCompany",
  "replyTo": "support@example.com",
  "topic": "customers",
  "attachmentIds": ["att_..."],
  "transactional": false,
  "enableTracking": true
}
```

`transactional: false` asks MailChannels to add non-transactional unsubscribe behavior. That requires working DKIM. Engagement tracking requires a supporting plan.

## Ad hoc sending

- `POST /send-email`

With a stored template:

```json
{
  "to": "alice@example.net",
  "from": "hello@example.com",
  "fromName": "AnyCompany",
  "templateName": "welcome",
  "data": { "firstName": "Alice" },
  "attachmentIds": []
}
```

Without one, omit `templateName` and provide `subject`, plus `text` and/or `html`.

## Operations

- `GET /dashboard`
- `GET /me`
- `GET /senders`
- `GET /suppressions?limit=100`
- `POST /admin/repair`
- `GET /health`

## Webhook

- `POST /webhooks/mailchannels`

The body is MailChannels' array of up to 1,000 events. `Content-Digest`, `Signature-Input`, and `Signature` are required when verification is enabled. Successful durable intake returns `202`.
