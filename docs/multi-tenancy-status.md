# Multi-tenancy implementation status

Phases 0–6 are implemented, with local acceptance in place. The original plan remains the design record. Per the implementation request, provider integration is exercised against local doubles rather than deploying to Cloudflare.

| Phase | Delivered                                                                                                                    | Local evidence                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Pinned dependencies, SQLite AccountDO import, custom hostname and themed HTML                                                | 5,000-contact D1/DO comparison; hostname/theme integration and browser tests                                                                                                       |
| 1     | Control-plane D1, lazy account schema migrations, account-prefixed R2, account-routed queues, compact campaign recipients    | Two-account foreign-resource and listing probes, real local SQLite/R2/queues                                                                                                       |
| 2     | Host-bound sessions, magic links, invitation/revocation, scoped permissions, audit, account users                            | All five account roles, one-use links, cross-host rejection, owner protections                                                                                                     |
| 3     | Encrypted parent/child keys, resumable provisioning, domains, tracking warm-up, local unsubscribe, reconciliation and pacing | Compensation/retry, distinct sending keys, suppression isolation, ambiguous-send recovery; 100-recipient account completes within 30 seconds alongside a 100,000-recipient backlog |
| 4     | Reseller console/API, hashed API keys, signed callbacks, OIDC/PKCE, panel SSO, restricted support sessions                   | API provisioning, one-use SSO, signed OIDC validation, callback retry and impersonation audit                                                                                      |
| 5     | Verified hostname routing, token/asset/CSS theme editor, server HTML injection, branded login mail and unsubscribe           | Hostname state transitions, CSS rejection, branded message assertions and browser save/reload                                                                                      |
| 6     | Platform console, search, plans, staff, health, alerts, DLQ replay, abuse controls, usage, export/deletion and retention     | Abuse event gating, retained daily rollups, deletion, replay, account file export and operator browser checks                                                                      |

## Implementation decisions

- Account data runs in a SQLite-backed Durable Object; the control plane uses D1. The SQL adapter preserves numbered parameters and transactional batches. Lazy account migrations currently reach version 3.
- Development uses ordinary provider sub-accounts plus a separate limit call, as allowed by the plan. Provider enrollment is mandatory before an account becomes active.
- Each new account starts at five sends/second and 1,000 sends/month. Clean history of at least seven days and 1,000 accepted messages unlocks its configured plan limits. Complaint/hard-bounce thresholds flag and pause campaigns; a subsequent distinct breach suspends the provider sub-account.
- A campaign with an ambiguous provider outcome waits one hour for reconciliation, retries once, then becomes unconfirmed if it is ambiguous again. This bounds retries but cannot guarantee exactly-once delivery without provider idempotency support.
- Tracking activation allows one new hostname per minute across the platform and warms HTTPS before enabling click/open tracking.
- Reseller system email uses a separate sending credential, configured by platform staff during onboarding or by the reseller. Parent management credentials never send customer campaigns.
- Export includes streamed account tables plus separately paginated original-file manifests/downloads. Deletion removes account storage, files, provider child and operational records. Redacted account tombstones and aggregate usage/audit records remain for accounting and accountability.
- Raw webhook payloads live under the account's R2 prefix. Event retention defaults to 90 days; retained daily aggregates survive event cleanup. EU accounts use the EU Durable Object jurisdiction namespace.

## Validation results

On 2026-10-02: `npm run check` passed all 67 tests across 11 files; `npm run build`, `npm run test:browser`, `wrangler deploy --dry-run`, and `git diff --check` passed. `npm audit` reported zero vulnerabilities. The deployment check was a local dry run only.

## Validation boundary

The suite uses real local Workers execution, SQLite, D1, R2, queues and alarms; only external providers are doubled. Browser smoke tests exercise account isolation, theme persistence and operator health. Run commands and manual acceptance steps are in [local development](local-development.md).

No production deployment or real message delivery was performed. The local hostname spike substitutes simulated DNS/TLS validation for the plan's live Cloudflare spike. A real pilot must still validate custom DNS/TLS, provider entitlements and response contracts, deployed Access configuration, email rendering/delivery, and physical data residency. External security review, fleet-scale load testing and the live reseller pilot remain Phase 7. The implementation does not migrate existing single-tenant customer data automatically.
