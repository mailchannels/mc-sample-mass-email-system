# API reference

All routes resolve the request hostname first. Customer routes under `/api` use the session's account. Reseller and platform consoles use `/api/reseller` and `/api/platform`; the provisioning API uses `/v1` with `Authorization: Bearer <reseller-api-key>`. Unknown routes and undeclared permissions fail closed. Cookie-authenticated mutations require an `Origin` matching the request origin.

## Identity

| Method   | Route                     | Body / behavior                                                                 |
| -------- | ------------------------- | ------------------------------------------------------------------------------- |
| POST     | `/api/auth/login`         | `{email, scopeType?, scopeId?}`; generic response; sends a 15-minute magic link |
| POST     | `/api/auth/consume`       | `{token}`; consumes the link and sets a host-only session cookie                |
| POST     | `/api/auth/logout`        | Revokes the current session                                                     |
| POST     | `/api/auth/revoke`        | Revokes the user's sessions                                                     |
| GET      | `/api/me`                 | Current scope, email, assignments and support-session state                     |
| GET      | `/api/auth/oidc/start`    | Begins reseller organization login                                              |
| GET      | `/api/auth/oidc/callback` | OIDC callback; verifies PKCE, state, nonce and ID token                         |
| POST     | `/api/auth/sso`           | `{token, issuer?}`; `issuer:"reseller"` selects the reseller panel secret       |
| GET/POST | `/api/users`              | List/invite users; POST `{email,role}`                                          |
| DELETE   | `/api/users/{id}`         | Remove scoped access and revoke matching sessions                               |
| POST     | `/api/users/{id}/invite`  | Resend an invitation without changing the role                                  |
| GET      | `/api/audit`              | Current scope's mutation and support history                                    |
| POST     | `/api/impersonation/stop` | Ends support access                                                             |

Reseller staff management uses `/api/reseller/users` and `/api/reseller/audit`. Platform reseller onboarding can manage staff through `/api/platform/resellers/{id}/users`, including the first owner. Platform staff are managed through `/api/users` on the platform hostname and authenticate with Access.

## Customer workspace

| Method         | Route                                                         | Body / behavior                                                                                    |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET            | `/api/dashboard`                                              | Account totals                                                                                     |
| GET/POST       | `/api/templates`                                              | POST `{name,subject,text?,html?}`                                                                  |
| GET/PUT/DELETE | `/api/templates/{name}`                                       | Read, update or remove a template                                                                  |
| GET            | `/api/recipients-lists`                                       | Import status, counts and hygiene summary                                                          |
| GET            | `/api/generate-upload-url?filename=contacts.csv&consent=true` | Creates a private, expiring upload ticket; `name` is optional                                      |
| PUT            | `/api/uploads/{token}`                                        | Raw body with `Content-Length`; bounded streaming upload                                           |
| DELETE         | `/api/recipients-lists/{id}`                                  | Deletes an unreferenced list and its source object                                                 |
| GET            | `/api/attachments`                                            | Test-message attachment library                                                                    |
| POST           | `/api/attachments/upload-url`                                 | `{filename,contentType}`                                                                           |
| DELETE         | `/api/attachments/{id}`                                       | Delete attachment                                                                                  |
| GET/POST       | `/api/campaigns`                                              | POST described below                                                                               |
| GET/PUT        | `/api/campaigns/{id}`                                         | Report / rename `{name}`; report supports `limit`, `cursor`, `search`                              |
| POST           | `/api/send-email`                                             | `{to,from,templateName?,subject?,text?,html?,data?,attachmentIds?}`; verified test recipients only |
| GET            | `/api/topics`, `/api/senders`, `/api/suppressions`            | Account-local metadata                                                                             |
| GET/PUT        | `/api/settings`                                               | PUT `{postalAddress,retentionDays}`                                                                |
| GET/POST       | `/api/domains`                                                | DNS records / create `{domain}`                                                                    |
| POST           | `/api/domains/{id}/verify`                                    | Check SPF, DKIM and Domain Lockdown                                                                |
| GET            | `/api/export`                                                 | Streamed account JSON; requires contact-export permission                                          |

Create a campaign with `{recipientListId,templateName,senderEmail,senderName?,replyTo?,name?,topic?,enableTracking?}`. The list must be ready, the sender domain verified, and the account postal address configured. `transactional:true` and campaign attachments are rejected. Tracking is used only when the account's custom domains are active. The result is `{campaignId,status,totalRecipients}` with HTTP 202.

`GET /unsubscribe?token=...` displays a themed confirmation. POST to the same signed URL records suppression, including standard one-click POSTs. The signature binds the email, account and reseller hostname; GET never changes subscription state.

## Reseller provisioning

The following are available under both `/api/reseller` (session) and `/v1` (key), subject to their declared permissions:

| Method     | Suffix                              | Body / behavior                                                    |
| ---------- | ----------------------------------- | ------------------------------------------------------------------ |
| GET/POST   | `/accounts`                         | POST `{name,planId,jurisdiction?}` with required `Idempotency-Key` |
| GET/DELETE | `/accounts/{id}`                    | Scoped metadata / resumable deletion                               |
| POST       | `/accounts/{id}/suspend`, `/resume` | Sender lifecycle                                                   |
| POST       | `/accounts/{id}/plan`               | `{planId}`; updates provider sending limit                         |
| GET        | `/accounts/{id}/usage`              | Daily account usage                                                |
| GET        | `/accounts/{id}/dns-records`        | Exact sender/tracking records                                      |
| POST       | `/accounts/{id}/verify`             | Verify/warm tracking domains                                       |
| POST       | `/accounts/{id}/retry`              | Resume provisioning                                                |
| POST       | `/accounts/{id}/sso`                | `{email}`; returns a one-use 60-second handoff URL                 |
| POST       | `/accounts/{id}/impersonate`        | `{reason}`; support role and session required                      |
| GET        | `/accounts/{id}/export`             | Operator export                                                    |

Session-only configuration uses:

- `GET/PUT /api/reseller/settings`: `trackingPattern`, `webhookUrl`, `systemEmailFrom`, `systemEmailKey`. System email uses its own sending key, never the management parent key.
- `GET/POST /api/reseller/api-keys`: POST `{scopes}` from `accounts.read`, `accounts.manage`, `usage.read`, `plans.write`, `sso.mint`; the raw key is returned once. DELETE `/api-keys/{id}` revokes it.
- `POST /api/reseller/integration-secret`: `{kind:"sso"|"webhook"}` rotates and returns a shared secret once.
- `PUT /api/reseller/oidc`: `{issuer,clientId,clientSecret}`.
- `GET/PUT /api/reseller/theme`: PUT `{tokens,css?}`. Tokens are `productName`, `primary`, `background`, `text`, `font`, `radius`, `supportLink`. Colors are six-digit hex; fonts are a fixed local list. Stylesheets have a 16 KiB cap and reject imports, resource URLs, escapes, attribute/pseudo selectors and unsupported properties.
- `PUT /api/reseller/theme/logo` or `/favicon`: PNG/JPEG bytes, at most 500 KiB; served from `/brand/logo` and `/brand/favicon` on that reseller's hostnames.
- `GET/POST /api/reseller/hostnames`: POST `{hostname}`; POST `/hostnames/{hostname}` refreshes validation. Both hostname and certificate must be active before routing is enabled.
- `GET /api/reseller/usage?format=csv`: invoicing export; JSON also includes separate provider billing-period snapshots.

### Panel handoff token

A reseller can obtain a handoff through `/v1/accounts/{id}/sso` or sign its own envelope with its panel secret:

```text
payload = {purpose:"panel-sso", resellerId, accountId, email, host,
           exp: UnixMillisecondsWithinNext60Seconds, nonce: UniqueRandomValue}
data = base64url(UTF8(JSON.stringify(payload)))
token = data + "." + base64url(HMAC-SHA256(panelSecret, data))
```

POST `{token,issuer:"reseller"}` to `/api/auth/sso` on `host`. The server checks the account belongs to that reseller and atomically consumes the nonce. The first handoff user becomes the account owner; subsequent new users receive marketer access. A handoff does not elevate an existing user's role.

Outbound callbacks include stable event `id`, `type`, `data` and `timestamp`. `x-event-signature` is the same HMAC envelope format, using the separately configured callback secret and containing that payload. Verify the HMAC and timestamp, and deduplicate by event ID. Failed deliveries retry with capped exponential backoff.

## Platform operations

Platform routes require Access and a matching platform permission:

- `GET/POST /api/platform/resellers`; POST `{name,planId,parentHandle,apiKey}` validates the parent key.
- `PUT /api/platform/resellers/{id}/mailchannels-key` with `{apiKey}` rotates it.
- Account lifecycle endpoints mirror reseller endpoints; creating an account additionally supplies `resellerId`.
- `GET/POST /api/platform/plans`; POST `{scopeType,monthlySends,contacts,rate}`.
- `GET /api/platform/search?q=...`, `/health`, `/dead-letters`, `/usage?format=csv`.
- `POST /api/platform/dead-letters/{id}/replay`.
- `POST /api/platform/alerts/{id}/resolve` or `/replay` (unknown-handle events).
- `POST /api/platform/abuse/{accountId}/suspend` or `/resume` for compliance staff.
- `POST /api/platform/maintenance` runs bounded reconciliation/metering work.
- Hostname endpoints mirror reseller endpoints, with `resellerId` on creation.

The public provider callback is `POST /webhooks/mailchannels` on the platform hostname. Production requests require signed content digest, signature metadata and Ed25519 verification. Unknown handles are retained as alerts and may be replayed after the routing mapping is corrected.

Original account files are available through `GET /api/export/files?cursor=...` (paginated manifest) and `GET /api/export/file?key=...` (download). Both require account contact-export permission and enforce the account R2 prefix.

Platform onboarding also supports `PUT /api/platform/resellers/{id}/system-email` with `{from, apiKey}` and `PUT /api/platform/resellers/{id}` with `{planId, status}`. Staff can inspect pending system emails and callbacks in health, retry callbacks with `POST /api/platform/callbacks/{id}/retry`, and replay unknown-handle events after linking the handle with `POST /api/platform/alerts/{id}/replay`.
