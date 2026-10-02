# Multi-tenant email service

A three-tier email marketing service: platform staff manage resellers, hosting providers manage customer accounts, and customers manage their campaigns in a branded workspace. The implementation follows [the multi-tenancy plan](docs/multi-tenancy-plan.md) through Phase 6, with local Workers integration tests.

Customer data lives in one SQLite Durable Object per account. A shared D1 control plane holds identities, reseller/account metadata, encrypted credentials, roles, hostnames, usage and audit records. R2 objects and queue jobs carry account identity. Sending uses a separate MailChannels sub-account key for each customer.

## Run locally

```sh
npm ci
npm run dev:local
```

Open `http://a.localhost:8790` for Account A, `http://b.localhost:8790` for Account B, and `http://platform.localhost:8790` for the platform console. Email capture is at `http://localhost:8790/__local/mailbox`.

The local environment uses real Workers storage, queues and alarms, with local test doubles for email and hostname providers. It requires no Cloudflare credentials and sends no real email. See [local development](docs/local-development.md) for provisioning and sending a complete campaign.

## Features

- Account isolation, scoped roles, host-bound sessions, magic links, invitations, OIDC and control-panel SSO.
- Reseller linking, encrypted key rotation, resumable child provisioning, plans, lifecycle APIs and signed callbacks.
- Resumable CSV import with consent, deduplication, hygiene flags and contact limits; templates and personalized campaigns.
- Account pacing, reseller/platform ceilings, verified sender domains, tracking-domain DNS handoff and certificate warm-up.
- Mandatory branded unsubscribe and postal footer, account-local suppressions, verified-recipient test sends and campaign attachment restrictions.
- Time-boxed support sessions with an actor/effective-user audit trail.
- Custom hostnames, theme tokens, logo/favicon assets, constrained CSS and branded system email.
- Platform search, health, abuse controls, daily metering, provider usage snapshots, failed-job inspection/replay, export, retention and deletion.

## Verify

```sh
npm run check
npm run build
```

The suite runs locally, including a 100,000-versus-100-recipient fairness test. Dependencies are pinned. Browser smoke testing is available with `npm run test:browser` while the local server is running.

## Deployment configuration

The repository does not deploy automatically. `wrangler.jsonc` declares control-plane D1, R2, queues, AccountDO and coarse rate limiters. Account schemas migrate lazily inside their objects; D1 migrations are in `migrations/control`.

For a new deployment, configure the actual resource bindings, `PLATFORM_HOST`, Cloudflare Access issuer/audience, `BOOTSTRAP_OWNER_EMAIL`, and independent `KEY_ENCRYPTION_SECRET` (base64-encoded 32 random bytes) and `SESSION_SECRET` secrets. Custom-hostname integration additionally needs `CF_ZONE_ID` and a scoped `CF_API_TOKEN`. The first verified Access login matching the bootstrap email creates the initial platform owner. Subsequent reseller and customer onboarding uses the consoles.

Parent email accounts are created separately and linked through the platform console. Customer sending keys are provisioned and encrypted in the control plane. A reseller configures a separate system-email key and sender for invitations; parent keys are used only for management. Keep `LOCAL_TEST` unset in deployed environments.

The original single-tenant D1 migration remains as historical source material. The new control-plane migration does **not** automatically move an existing deployment's tenant rows into AccountDO. Existing data needs a planned export/import cutover; do not apply this as an in-place conversion of a live single-tenant database.

Live provider/DNS/certificate validation, external security assessment and a production pilot remain outside the local validation performed here. See [implementation status](docs/multi-tenancy-status.md), [architecture](docs/architecture.md), and [API reference](docs/api.md).

## CSV and templates

```csv
email,first_name,last_name,topics,company
alice@example.net,Alice,Ng,newsletter,Acme
```

Columns are available as merge data, with standard aliases `email`, `firstName`, `lastName`, `topics`, `unsubscribe_url` and `postal_address`. Campaign expansion stores the source recipient ID and email rather than copying the complete merge row into every campaign.

## License

MIT No Attribution (MIT-0). See [LICENSE](LICENSE). This project originated as an independent Cloudflare/MailChannels implementation of the AWS sample mass email system.
