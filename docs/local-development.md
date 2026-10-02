# Local multi-tenant environment

```sh
npm ci
npm run dev:local
```

This starts a real local Workers runtime with SQLite Durable Objects, D1, R2, queues, alarms, the built React application, and local MailChannels / custom-hostname test doubles. It does not deploy or make provider API calls. Node.js 22+ is required.

| URL                                     | Identity / scope                                       |
| --------------------------------------- | ------------------------------------------------------ |
| `http://a.localhost:8790`               | `developer@local.test`, Account A and reseller A owner |
| `http://b.localhost:8790`               | `other@local.test`, Account B owner                    |
| `http://platform.localhost:8790`        | `platform@local.test`, platform owner                  |
| `http://localhost:8790/__local/mailbox` | Local login links and captured outbound messages       |

Use `LOCAL_PORT=8791 npm run dev:local` if needed. State persists in `.local/state`; stop the server and remove that directory to reset the local sandbox. The local server listens on loopback. Development identities, mock DNS success, mock certificate success, and disabled webhook signatures exist only when `LOCAL_TEST=true`. The production configuration does not set that flag.

## Demonstrate the service

1. Open the platform console, choose **resellers**, and link a reseller using plan `reseller` and dummy parent credentials (for example handle `pilot`, key `local-parent-key`). The local provider validates all nonempty dummy credentials.
2. Configure the reseller’s system email in the platform console with a dummy sending key and sender address. Use the reseller's **Manage staff** action to invite an owner. Add a hostname under **hostnames**, then verify it. Locally, use a hostname that resolves to loopback, such as `pilot.localhost`, or send an explicit Host header with curl. The local hostname double marks the hostname active when verified; this is not real DNS validation.
3. Create an account using plan `starter`, selecting its reseller and `default` or `eu` jurisdiction. Provisioning creates a child, issues its key, enrols its webhook, and sets its limit.
4. Use **Customer sign-in link** for that account, enter the customer's email, and follow the handoff. The first SSO customer becomes the owner. SSO tokens are one-use and expire in 60 seconds.
5. In the customer workspace, open **Settings & users**, set the postal address, add a sender domain, and verify its DNS. DNS checks use the local provider double.
6. Create a template, import a CSV after affirming consent, and launch a campaign. Inspect messages at `/__local/mailbox`; no real email is sent. Open a captured unsubscribe link and submit the form to see account-local suppression.
7. Inspect usage, alerts and failed jobs from the platform console. Maintenance runs once per minute, or use **Run maintenance**. Account alarms pace delivery independently.

Seeded Accounts A and B are isolation fixtures without email credentials. Provision a new account for the sending demonstration, or link/configure their reseller through the platform console and use the APIs.

## Verification

```sh
npm run check             # TypeScript and all unit/integration tests
npm run build             # React production build
npm run test:integration  # Local runtime tests
npm run test:browser      # Start dev:local separately; Chromium must be installed
```

Install the browser once with `npx playwright install chromium`. Tests use ephemeral stores and in-process provider doubles. The test suites cover:

- Foreign-resource probes for templates, lists, upload tickets, attachments, campaigns and sender domains; scoped listings and unknown hosts.
- Account role permissions, host-only sessions, one-use magic links and SSO, OIDC PKCE/nonce/state/signature validation, invitation and support-session restrictions.
- Provisioning compensation and resume, child credentials, R2 imports, queue expansion, send claims, unsubscribe, webhook reconciliation, unknown handles, failed-job replay, theme injection and hostname verification.
- Signed outbound callbacks, branded login email, abuse flags, daily usage after retention, and account deletion.
- A 5,000-contact D1/AccountDO import comparison.
- A 100,000-recipient backlog beside a 100-recipient account. At five releases/second per new account, the small account must finish within 30 seconds (its nominal 20-second budget plus ten seconds of local scheduling overhead).

These tests establish local behavior. They do not establish production DNS ownership, real certificate issuance, provider entitlement, deployed Access policy, EU physical data residency, or fleet-scale performance. Those need the live integration checks and pilot work in Phase 7.
