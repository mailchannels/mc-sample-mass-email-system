import {
  Fragment,
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { api, jsonBody } from "./api";
import { CustomerApp } from "./App";
import {
  BackLink,
  Card,
  Empty,
  ErrorBox,
  Field,
  Icon,
  Loading,
  Metric,
  PageHeading,
  SessionContext,
  Shell,
  Status,
  capitalize,
  formatDate,
  formatNumber,
  productTheme,
  useData,
  type Me,
  type NavItem,
  type Row,
} from "./ui";

export function Portal() {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<Me>("/me")
      .then(setMe)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <Loading />;
  if (!me) return <Login error={error} />;
  return (
    <SessionContext.Provider value={me}>
      {me.impersonating && (
        <div className="support-banner" role="status">
          Support access · {me.scopeId} · {me.reason}
          <button
            onClick={() =>
              api("/impersonation/stop", { method: "POST" }).then(() =>
                location.assign("/"),
              )
            }
          >
            End support session
          </button>
        </div>
      )}
      <View me={me} />
    </SessionContext.Provider>
  );
}

function View({ me }: { me: Me }) {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  if (me.scopeType === "platform") return <OperatorConsole platform />;
  if (
    !me.impersonating &&
    (me.scopeType === "reseller" || hash.startsWith("#reseller"))
  )
    return <OperatorConsole />;
  return <CustomerApp />;
}

function Login({ error }: { error: string }) {
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const token = new URLSearchParams(location.search).get("token");
  const sso = location.pathname === "/sso";
  const productName = productTheme().productName ?? "Email Studio";
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    setFailure("");
    try {
      if (token) {
        await api(sso ? "/auth/sso" : "/auth/consume", {
          method: "POST",
          ...jsonBody({ token }),
        });
        location.replace("/");
      } else {
        const result = await api<{ message: string }>("/auth/login", {
          method: "POST",
          ...jsonBody({ email: address }),
        });
        setNotice(result.message);
      }
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          {productTheme().logo ? (
            <>
              <img className="brand-image" src={productTheme().logo} alt="" />
              <span className="brand-div" />
            </>
          ) : (
            <span className="brand-mark" aria-hidden="true">
              {productName.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="brand-name">
            <strong>{productName}</strong>
            <small>Secure sign-in</small>
          </span>
        </div>
        <h1>{token ? "Continue to your workspace" : "Sign in"}</h1>
        <p className="auth-lead">
          {token
            ? "This link works once and expires shortly. Continue to open your session."
            : "Enter your work email and we’ll send you a one-time sign-in link."}
        </p>
        <form onSubmit={login}>
          {!token && (
            <Field label="Email address">
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? "Working…"
              : token
                ? "Continue securely"
                : "Email me a sign-in link"}
          </button>
        </form>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {failure && (
          <p className="form-error" role="alert">
            {failure}
          </p>
        )}
        {error && !/401|sign in|authenticat/i.test(error) && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!token && (
          <div className="auth-actions">
            <a className="link-button" href="/api/auth/oidc/start">
              Sign in with your organization
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

/* ---------- Forms, tables and actions ---------- */

type Option = string | { value: string; label: string };
interface FieldSpec {
  key: string;
  label: string;
  type?: string;
  value?: string;
  options?: Option[];
  hint?: string;
  placeholder?: string;
  required?: boolean;
  wide?: boolean;
}

export function Form({
  title,
  description,
  fields,
  submit,
  submitLabel,
  onDone,
  resultNote,
  bare = false,
  secondary = false,
}: {
  /** Secondary submit, for forms that share a view with the page's primary action. */
  secondary?: boolean;
  title?: string;
  description?: ReactNode;
  fields: FieldSpec[];
  submit: (values: Record<string, string>) => Promise<unknown>;
  submitLabel?: string;
  onDone?: (result: unknown) => void;
  resultNote?: string;
  bare?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""])),
  );
  const [result, setResult] = useState<unknown>();
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDone(false);
    setFailure("");
    try {
      const value = await submit(values);
      setResult(value);
      setDone(true);
      // Never keep secrets in the form after they have been sent.
      setValues((current) =>
        Object.fromEntries(
          fields.map((f) => [
            f.key,
            f.type === "password" ? "" : current[f.key],
          ]),
        ),
      );
      onDone?.(value);
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }
  const detail =
    result && !(typeof result === "object" && isOk(result as Row))
      ? JSON.stringify(result, null, 2)
      : "";
  const body = (
    <form onSubmit={save}>
      {description && <p className="card-note">{description}</p>}
      <div className="form-grid">
        {fields.map((f) => (
          <div className={f.wide ? "wide" : ""} key={f.key}>
            <Field label={f.label} hint={f.hint}>
              {f.options ? (
                <select
                  required={f.required}
                  aria-label={f.label}
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  <option value="">Select…</option>
                  {f.options.map((o) => {
                    const { value, label } =
                      typeof o === "string" ? { value: o, label: o } : o;
                    return (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  rows={5}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <input
                  type={f.type ?? "text"}
                  required={f.required}
                  placeholder={f.placeholder}
                  autoComplete={f.type === "password" ? "new-password" : "off"}
                  aria-label={f.label}
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </Field>
          </div>
        ))}
      </div>
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      {done && (
        <div className="notice" aria-live="polite">
          {detail ? (resultNote ?? "Done. Response:") : "Saved."}
          {detail && <pre className="result">{detail}</pre>}
        </div>
      )}
      <div className="form-actions">
        <button className={secondary ? "secondary" : "primary"} disabled={busy}>
          {busy ? "Working…" : (submitLabel ?? title)}
        </button>
      </div>
    </form>
  );
  return bare ? body : <Card title={title}>{body}</Card>;
}

interface Column {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
}

export function Table({
  rows,
  columns,
  actions,
  onSelect,
  expand,
  empty = ["Nothing here yet", "Records will appear here as they are created."],
}: {
  rows: Row[];
  columns?: Column[];
  actions?: (row: Row) => ReactNode;
  onSelect?: (row: Row) => void;
  expand?: (row: Row) => ReactNode;
  empty?: [string, string];
}) {
  const [open, setOpen] = useState<number>();
  if (!rows.length) return <Empty title={empty[0]} text={empty[1]} />;
  const cols: Column[] =
    columns ??
    [...new Set(rows.flatMap(Object.keys))]
      .filter((k) => !/_json$|^body$|_ref$/.test(k))
      .slice(0, 8)
      .map((key) => ({ key, label: humanize(key) }));
  const clickable = Boolean(onSelect || expand);
  const activate = (row: Row, i: number) =>
    onSelect ? onSelect(row) : setOpen(open === i ? undefined : i);
  return (
    <div className="table-wrap">
      <table className={clickable ? "clickable" : ""}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            {actions && <th className="actions-col" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <Fragment key={String(row.id ?? row.hostname ?? i)}>
              <tr
                className={open === i ? "open" : ""}
                {...(clickable && {
                  tabIndex: 0,
                  role: onSelect ? "link" : "button",
                  "aria-expanded": onSelect ? undefined : open === i,
                  onClick: () => activate(row, i),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate(row, i);
                    }
                  },
                })}
              >
                {cols.map((c) => (
                  <td key={c.key}>
                    {c.render ? c.render(row) : cell(c.key, row[c.key])}
                  </td>
                ))}
                {actions && (
                  <td
                    className="row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div>{actions(row)}</div>
                  </td>
                )}
              </tr>
              {expand && open === i && (
                <tr className="expansion">
                  <td colSpan={cols.length + (actions ? 1 : 0)}>
                    {expand(row)}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataView({
  title,
  path,
  collection,
  columns,
  actions,
  onSelect,
  expand,
  empty,
  headerAction,
}: {
  title: string;
  path: string;
  collection?: string;
  columns?: Column[];
  actions?: (row: Row, reload: () => void) => ReactNode;
  onSelect?: (row: Row) => void;
  expand?: (row: Row) => ReactNode;
  empty?: [string, string];
  headerAction?: ReactNode;
}) {
  const { data, loading, error, reload } = useData<Row>(path);
  const rows = (
    data
      ? ((collection
          ? data[collection]
          : Object.values(data).find(Array.isArray)) ?? [])
      : []
  ) as Row[];
  return (
    <Card
      title={<CardTitle title={title} count={data ? rows.length : undefined} />}
      action={
        <div className="card-actions">
          {headerAction}
          <button onClick={reload}>Refresh</button>
        </div>
      }
    >
      {loading ? (
        <Loading small />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : (
        <Table
          rows={rows}
          columns={columns}
          actions={actions && ((row) => actions(row, reload))}
          onSelect={onSelect}
          expand={expand}
          empty={empty}
        />
      )}
    </Card>
  );
}

function CardTitle({ title, count }: { title: string; count?: number }) {
  return (
    <>
      {title}
      {count !== undefined && <span className="count">{count}</span>}
    </>
  );
}

function Action({
  label,
  run,
  variant = "link",
  confirmText,
}: {
  label: string;
  run: () => Promise<unknown>;
  variant?: "link" | "secondary" | "primary" | "danger";
  /** Destructive actions ask inline before running; there are no modal dialogs. */
  confirmText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState("");
  const className = {
    link: "link-button",
    secondary: "secondary",
    primary: "primary",
    danger: "text-danger",
  }[variant];
  async function go() {
    setAsking(false);
    setBusy(true);
    setFailure("");
    try {
      await run();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="action">
      {asking ? (
        <span className="confirm" role="group" aria-label={confirmText}>
          {confirmText}
          <button type="button" className="danger small" onClick={go}>
            {label}
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => setAsking(false)}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={className}
          disabled={busy}
          onClick={() => (confirmText ? setAsking(true) : go())}
        >
          {busy ? "Working…" : label}
        </button>
      )}
      {failure && (
        <small className="inline-error" role="alert">
          {failure}
        </small>
      )}
    </span>
  );
}

function Json({ value }: { value: unknown }) {
  let parsed = value;
  if (typeof value === "string")
    try {
      parsed = JSON.parse(value);
    } catch {
      /* show the raw text */
    }
  return (
    <pre className="result">
      {typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}
    </pre>
  );
}

function DnsTable({ records }: { records: Row[] }) {
  return (
    <Table
      rows={records}
      columns={[
        {
          key: "type",
          label: "Type",
          render: (r) => <code>{String(r.type)}</code>,
        },
        {
          key: "name",
          label: "Host",
          render: (r) => <code>{String(r.name)}</code>,
        },
        {
          key: "value",
          label: "Value",
          render: (r) => <code className="wrap">{String(r.value)}</code>,
        },
      ]}
      empty={[
        "No DNS records yet",
        "Records appear once a sender or tracking domain is configured.",
      ]}
    />
  );
}

/* ---------- Users and account settings ---------- */

const roleOptions: Record<string, string[]> = {
  account: ["owner", "admin", "marketer", "author", "viewer"],
  reseller: ["owner", "admin", "support", "billing"],
  platform: ["owner", "admin", "support", "compliance", "billing"],
};

export function Users({
  root = "",
  scope,
}: {
  root?: string;
  scope: "account" | "reseller" | "platform";
}) {
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  return (
    <>
      <section className="split">
        <DataView
          key={"users" + version}
          title="Team members"
          path={root + "/users"}
          columns={[
            {
              key: "email",
              label: "Email",
              render: (r) => <strong>{String(r.email)}</strong>,
            },
            {
              key: "role",
              label: "Role",
              render: (r) => <Status value={String(r.role)} />,
            },
          ]}
          empty={["No team members", "Invite someone to share access."]}
          actions={(row, reload) => (
            <>
              <Action
                label="Resend invite"
                run={() =>
                  api(root + "/users/" + row.id + "/invite", { method: "POST" })
                }
              />
              <Action
                label="Remove"
                variant="danger"
                confirmText={`Remove access for ${row.email}?`}
                run={() =>
                  api(root + "/users/" + row.id, { method: "DELETE" }).then(
                    reload,
                  )
                }
              />
            </>
          )}
        />
        <Form
          title="Invite user"
          description="They’ll receive a one-time sign-in link by email."
          submitLabel="Send invitation"
          fields={[
            {
              key: "email",
              label: "Email",
              type: "email",
              required: true,
              placeholder: "name@company.com",
              wide: true,
            },
            {
              key: "role",
              label: "Role",
              options: roleOptions[scope],
              required: true,
              value: scope === "account" ? "marketer" : "admin",
              wide: true,
            },
          ]}
          submit={(v) =>
            api(root + "/users", { method: "POST", ...jsonBody(v) })
          }
          onDone={refresh}
        />
      </section>
      <DataView
        title="Access history"
        path={root + "/audit"}
        columns={[
          { key: "at", label: "When", render: (r) => formatDate(r.at) },
          {
            key: "action",
            label: "Action",
            render: (r) => <strong>{String(r.action)}</strong>,
          },
          {
            key: "target",
            label: "Target",
            render: (r) => <code>{String(r.target)}</code>,
          },
          {
            key: "actor_user_id",
            label: "Actor",
            render: (r) => (
              <small className="mono">{String(r.actor_user_id)}</small>
            ),
          },
        ]}
        expand={(r) => <Json value={r.detail_json} />}
        empty={["No activity yet", "Sign-ins and changes are recorded here."]}
      />
    </>
  );
}

export function AccountSettings() {
  const settings = useData<{ postal_address: string; retention_days: number }>(
    "/settings",
  );
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeading
        kicker="Account"
        title="Settings & users"
        text="Sender identity, domains and the people who can use this workspace."
        action={
          <a className="secondary" href="/api/export" download>
            Export account data
          </a>
        }
      />
      <section className="split">
        <DataView
          key={"domains" + version}
          title="Sender domains"
          path="/domains"
          collection="domains"
          columns={[
            {
              key: "domain",
              label: "Domain",
              render: (r) => <strong>{String(r.domain)}</strong>,
            },
            {
              key: "verified_at",
              label: "Status",
              render: (r) => (
                <Status value={r.verified_at ? "verified" : "pending"} />
              ),
            },
            {
              key: "checks",
              label: "Checks",
              render: (r) => (
                <span className="checks">
                  {(["spf", "dkim", "lockdown"] as const).map((k) => (
                    <i key={k} className={r[k + "_ok"] ? "ok" : ""}>
                      {k.toUpperCase()}
                    </i>
                  ))}
                </span>
              ),
            },
          ]}
          expand={(r) => <DnsTable records={parseList(r.records_json)} />}
          empty={[
            "No sender domains",
            "Add the domain you send from, then publish its DNS records.",
          ]}
          actions={(row, reload) => (
            <Action
              label="Verify DNS"
              run={() =>
                api(`/domains/${row.id}/verify`, { method: "POST" }).then(
                  reload,
                )
              }
            />
          )}
        />
        <div>
          <Form
            title="Add sender domain"
            description="Click a domain in the list to see the DNS records to publish."
            submitLabel="Add domain"
            fields={[
              {
                key: "domain",
                label: "Domain",
                placeholder: "mail.example.com",
                required: true,
                wide: true,
              },
            ]}
            submit={(v) => api("/domains", { method: "POST", ...jsonBody(v) })}
            onDone={() => setVersion((v) => v + 1)}
            resultNote="Domain added. Publish these records, then verify:"
          />
          {settings.loading ? (
            <Card title="Sender settings">
              <Loading small />
            </Card>
          ) : (
            <Form
              title="Sender settings"
              description="Your postal address appears in every message footer, as anti-spam law requires."
              submitLabel="Save settings"
              fields={[
                {
                  key: "postalAddress",
                  label: "Postal address",
                  value: settings.data?.postal_address ?? "",
                  required: true,
                  wide: true,
                },
                {
                  key: "retentionDays",
                  label: "Data retention",
                  hint: "7–365 days",
                  type: "number",
                  value: String(settings.data?.retention_days ?? 90),
                  wide: true,
                },
              ]}
              submit={(v) =>
                api("/settings", {
                  method: "PUT",
                  ...jsonBody({
                    postalAddress: v.postalAddress,
                    retentionDays: Number(v.retentionDays),
                  }),
                })
              }
            />
          )}
        </div>
      </section>
      <Users scope="account" />
    </>
  );
}

/* ---------- Operator console (platform and reseller) ---------- */

const platformNav: NavItem[] = [
  { key: "dashboard", label: "Overview", icon: "overview" },
  { key: "accounts", label: "Accounts", icon: "building" },
  { key: "resellers", label: "Resellers", icon: "briefcase" },
  { key: "plans", label: "Plans", icon: "layers" },
  { key: "usage", label: "Usage", icon: "chart" },
  { key: "health", label: "Health", icon: "pulse" },
  { key: "failed-jobs", label: "Failed jobs", icon: "warn" },
  { key: "hostnames", label: "Hostnames", icon: "globe" },
  { key: "search", label: "Search", icon: "search" },
  { key: "staff", label: "Staff", icon: "shield" },
];
const resellerNav: NavItem[] = [
  { key: "dashboard", label: "Overview", icon: "overview" },
  { key: "accounts", label: "Accounts", icon: "building" },
  { key: "usage", label: "Usage", icon: "chart" },
  { key: "branding", label: "Branding", icon: "palette" },
  { key: "hostnames", label: "Hostnames", icon: "globe" },
  { key: "integrations", label: "Integrations", icon: "plug" },
  { key: "staff", label: "Staff", icon: "shield" },
];

interface Ctx {
  platform: boolean;
  root: string;
  go: (route: string) => void;
}

function useRoute(prefix: string) {
  const read = () => {
    const hash = decodeURIComponent(location.hash.slice(1));
    const rest = prefix ? hash.replace(new RegExp(`^${prefix}/?`), "") : hash;
    const [page = "", ...id] = rest.split("/");
    return { page: page || "dashboard", id: id.join("/") };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const changed = () => {
      setRoute(read());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return route;
}

function OperatorConsole({ platform = false }: { platform?: boolean }) {
  const prefix = platform ? "" : "reseller";
  const { page, id } = useRoute(prefix);
  const go = (next: string) => {
    location.hash = prefix ? `${prefix}/${next}` : next;
  };
  const ctx: Ctx = { platform, root: platform ? "/platform" : "/reseller", go };
  const nav = platform ? platformNav : resellerNav;
  const { productName } = productTheme();
  return (
    <Shell
      name={platform ? "Platform console" : (productName ?? "Email Studio")}
      tagline={platform ? "Mass email operations" : "Reseller console"}
      nav={nav}
      active={page}
      href={(key) => "#" + (prefix ? `${prefix}/${key}` : key)}
      scope={platform ? "platform" : "reseller"}
      mailchannels={platform}
      links={
        !platform && (
          <a className="pill" href="#dashboard">
            Account workspace
          </a>
        )
      }
    >
      {page === "dashboard" && <Overview {...ctx} />}
      {page === "accounts" && <AccountsPage {...ctx} id={id} />}
      {page === "resellers" && platform && <ResellersPage {...ctx} id={id} />}
      {page === "plans" && platform && <PlansPage {...ctx} />}
      {page === "usage" && <UsagePage {...ctx} />}
      {page === "health" && platform && <HealthPage {...ctx} />}
      {page === "failed-jobs" && platform && <FailedJobsPage {...ctx} />}
      {page === "hostnames" && <HostnamesPage {...ctx} />}
      {page === "search" && platform && <SearchPage {...ctx} />}
      {page === "staff" && (
        <>
          <PageHeading
            kicker="Access"
            title="Staff"
            text={
              platform
                ? "Operators with access to the platform console. Manage a reseller’s staff from its detail page."
                : "People on your team who can manage accounts, branding and integrations."
            }
          />
          <Users
            root={platform ? "" : "/reseller"}
            scope={platform ? "platform" : "reseller"}
          />
        </>
      )}
      {page === "branding" && !platform && <Branding />}
      {page === "integrations" && !platform && <Integrations />}
      {!nav.some((n) => n.key === page) && (
        <Empty
          title="Page not found"
          text="Choose a section from the sidebar."
        />
      )}
    </Shell>
  );
}

function Overview({ platform, root, go }: Ctx) {
  const accounts = useData<{ accounts: Row[] }>(root + "/accounts");
  const usage = useData<{ usage: Row[] }>(root + "/usage");
  const health = useData<Record<string, Row[]>>(
    platform ? "/platform/health" : "",
  );
  const failed = useData<{ messages: Row[] }>(
    platform ? "/platform/dead-letters" : "",
  );
  const resellers = useData<{ resellers: Row[] }>(
    platform ? "/platform/resellers" : "",
  );
  if (accounts.loading) return <Loading />;
  if (accounts.error || !accounts.data)
    return <ErrorBox error={accounts.error} retry={accounts.reload} />;
  const list = accounts.data.accounts;
  const byStatus = (s: string) => list.filter((a) => a.status === s).length;
  const totals = sumUsage(usage.data?.usage ?? []);
  const h = health.data ?? {};
  const pendingFailed = (failed.data?.messages ?? []).filter(
    (m) => !m.replayed_at,
  ).length;
  const attention: [string, number, string, string][] = platform
    ? [
        [
          "Open alerts",
          h.alerts?.length ?? 0,
          "health",
          "Unresolved provider and webhook alerts",
        ],
        [
          "Provisioning issues",
          h.provisioning?.length ?? 0,
          "health",
          "Accounts whose setup has not finished",
        ],
        [
          "Pending callbacks",
          h.callbacks?.length ?? 0,
          "health",
          "Reseller webhooks awaiting delivery",
        ],
        [
          "Unsent system email",
          h.systemEmail?.length ?? 0,
          "health",
          "Invitations and sign-in links in retry",
        ],
        [
          "Failed jobs",
          pendingFailed,
          "failed-jobs",
          "Queue messages awaiting replay",
        ],
      ]
    : [
        [
          "Provisioning",
          byStatus("PROVISIONING"),
          "accounts",
          "Accounts still being set up",
        ],
        [
          "Suspended",
          byStatus("SUSPENDED"),
          "accounts",
          "Accounts that cannot send",
        ],
      ];
  const open = attention.filter(([, count]) => count > 0);
  return (
    <>
      <PageHeading
        kicker={platform ? "Platform operations" : "Reseller operations"}
        title="Overview"
        text={
          platform
            ? "Every reseller, account and background job on this deployment."
            : "The accounts you manage, their sending volume and anything that needs attention."
        }
        action={
          <button className="primary" onClick={() => go("accounts/new")}>
            <Icon name="plus" />
            New account
          </button>
        }
      />
      <section className="metrics">
        <Metric
          label="Accounts"
          value={list.length}
          note={`${byStatus("ACTIVE")} active · ${byStatus("SUSPENDED")} suspended`}
          color="green"
        />
        {platform ? (
          <Metric
            label="Resellers"
            value={resellers.data?.resellers.length ?? 0}
            note={`${(resellers.data?.resellers ?? []).filter((r) => r.status === "ACTIVE").length} active`}
            color="blue"
          />
        ) : (
          <Metric
            label="Provisioning"
            value={byStatus("PROVISIONING")}
            note="accounts in setup"
            color="blue"
          />
        )}
        <Metric
          label="Accepted"
          value={totals.accepted}
          note={`${formatNumber(totals.delivered)} delivered`}
          color="lime"
        />
        {platform ? (
          <Metric
            label="Needs attention"
            value={open.reduce((n, [, count]) => n + count, 0)}
            note={`${h.alerts?.length ?? 0} alerts · ${pendingFailed} failed jobs`}
            color="warn"
          />
        ) : (
          <Metric
            label="Exceptions"
            value={totals.bounced + totals.complained}
            note={`${formatNumber(totals.bounced)} bounced · ${formatNumber(totals.complained)} complaints`}
            color="warn"
          />
        )}
      </section>
      <section className="split">
        <Card
          title="Recent accounts"
          action={<button onClick={() => go("accounts")}>View all →</button>}
        >
          <AccountTable
            rows={list.slice(0, 6)}
            platform={platform}
            go={go}
            compact
          />
        </Card>
        <Card title="Needs attention">
          {open.length ? (
            <div className="checklist">
              {open.map(([label, count, route, text]) => (
                <button key={label} onClick={() => go(route)}>
                  <span>{count}</span>
                  <div>
                    <strong>{label}</strong>
                    <small>{text}</small>
                  </div>
                  <b>→</b>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="All clear"
              text="Nothing is waiting on an operator right now."
            />
          )}
        </Card>
      </section>
    </>
  );
}

function AccountTable({
  rows,
  platform,
  go,
  compact = false,
}: {
  rows: Row[];
  platform: boolean;
  go: (route: string) => void;
  compact?: boolean;
}) {
  return (
    <Table
      rows={rows}
      onSelect={(r) => go(`accounts/${r.id}`)}
      empty={[
        "No accounts yet",
        "Create an account to provision a sending workspace.",
      ]}
      columns={[
        {
          key: "name",
          label: "Account",
          render: (r) => (
            <>
              <strong>{String(r.name)}</strong>
              <small>{String(r.id)}</small>
            </>
          ),
        },
        ...(platform ? [{ key: "reseller_id", label: "Reseller" }] : []),
        { key: "status", label: "Status" },
        ...(compact
          ? []
          : [
              { key: "plan_id", label: "Plan" },
              { key: "jurisdiction", label: "Data location" },
            ]),
        { key: "created_at", label: "Created" },
      ]}
    />
  );
}

function AccountsPage({ platform, root, go, id }: Ctx & { id: string }) {
  const [filter, setFilter] = useState("");
  const accounts = useData<{ accounts: Row[] }>(root + "/accounts");
  if (id === "new")
    return <NewAccount platform={platform} root={root} go={go} />;
  if (id)
    return <AccountDetail platform={platform} root={root} go={go} id={id} />;
  const q = filter.toLowerCase();
  const rows = (accounts.data?.accounts ?? []).filter((a) =>
    [a.name, a.id, a.reseller_id, a.status].some((v) =>
      String(v ?? "")
        .toLowerCase()
        .includes(q),
    ),
  );
  return (
    <>
      <PageHeading
        kicker="Accounts"
        title="Accounts"
        text="Each account is an isolated sending workspace with its own contacts, templates, limits and credentials."
        action={
          <button className="primary" onClick={() => go("accounts/new")}>
            <Icon name="plus" />
            New account
          </button>
        }
      />
      <Card
        title={
          <CardTitle
            title="All accounts"
            count={accounts.data ? rows.length : undefined}
          />
        }
        action={
          <div className="card-actions">
            <input
              className="search"
              placeholder="Filter accounts…"
              aria-label="Filter accounts"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button onClick={accounts.reload}>Refresh</button>
          </div>
        }
      >
        {accounts.loading ? (
          <Loading small />
        ) : accounts.error ? (
          <ErrorBox error={accounts.error} retry={accounts.reload} />
        ) : (
          <AccountTable rows={rows} platform={platform} go={go} />
        )}
      </Card>
    </>
  );
}

function usePlans(root: string, scope: "account" | "reseller") {
  const plans = useData<{ plans: Row[] }>(root + "/plans");
  return (plans.data?.plans ?? [])
    .filter((p) => p.scope_type === scope)
    .map((p) => ({
      value: String(p.id),
      label: `${p.id} · ${formatNumber(Number(p.monthly_sends))} sends/mo · ${p.rate}/s`,
    }));
}

function useResellerOptions(platform: boolean) {
  const resellers = useData<{ resellers: Row[] }>(
    platform ? "/platform/resellers" : "",
  );
  return (resellers.data?.resellers ?? []).map((r) => ({
    value: String(r.id),
    label: `${r.name} (${r.id})`,
  }));
}

function NewAccount({ platform, root, go }: Omit<Ctx, "id">) {
  const plans = usePlans(root, "account");
  const resellers = useResellerOptions(platform);
  const ready = plans.length > 0 && (!platform || resellers.length > 0);
  return (
    <>
      <BackLink label="All accounts" onClick={() => go("accounts")} />
      <PageHeading
        kicker="Accounts"
        title="New account"
        text="Provisioning creates the sending sub-account, issues its key, enrols its event webhook and applies the plan limit."
      />
      <div className="narrow">
        {ready ? (
          <Form
            title="Account details"
            submitLabel="Create account"
            fields={[
              {
                key: "name",
                label: "Account name",
                required: true,
                placeholder: "Acme Corp",
              },
              {
                key: "planId",
                label: "Plan",
                options: plans,
                value: plans.some((p) => p.value === "starter")
                  ? "starter"
                  : "",
                required: true,
              },
              ...(platform
                ? [
                    {
                      key: "resellerId",
                      label: "Reseller",
                      options: resellers,
                      required: true,
                    },
                  ]
                : []),
              {
                key: "jurisdiction",
                label: "Data location",
                value: "default",
                required: true,
                options: [
                  { value: "default", label: "Default (global)" },
                  { value: "eu", label: "European Union" },
                ],
              },
            ]}
            submit={(v) =>
              api(root + "/accounts", {
                method: "POST",
                headers: { "idempotency-key": crypto.randomUUID() },
                ...jsonBody(v),
              })
            }
            onDone={(result) => {
              const created = (result as { id?: string })?.id;
              go(created ? `accounts/${created}` : "accounts");
            }}
          />
        ) : (
          <Loading small />
        )}
      </div>
    </>
  );
}

function AccountDetail({ platform, root, go, id }: Ctx & { id: string }) {
  const accounts = useData<{ accounts: Row[] }>(root + "/accounts");
  const usage = useData<{ usage: Row[] }>(`${root}/accounts/${id}/usage`);
  const dns = useData<{ records: Row[] }>(`${root}/accounts/${id}/dns-records`);
  const plans = usePlans(root, "account");
  const [plan, setPlan] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const base = `${root}/accounts/${id}`;
  if (accounts.loading) return <Loading />;
  const account = accounts.data?.accounts.find((a) => a.id === id);
  if (!account)
    return (
      <>
        <BackLink label="All accounts" onClick={() => go("accounts")} />
        {accounts.error ? (
          <ErrorBox error={accounts.error} retry={accounts.reload} />
        ) : (
          <Empty title="Account not found" text="It may have been deleted." />
        )}
      </>
    );
  const status = String(account.status);
  const totals = sumUsage(usage.data?.usage ?? []);
  const post = (action: string, body?: unknown) =>
    api(`${base}/${action}`, {
      method: "POST",
      ...(body ? jsonBody(body) : {}),
    });
  return (
    <>
      <BackLink label="All accounts" onClick={() => go("accounts")} />
      <PageHeading
        kicker="Account"
        title={String(account.name)}
        text={
          <>
            {id} · reseller {String(account.reseller_id)} ·{" "}
            {account.jurisdiction === "eu"
              ? "EU data location"
              : "default data location"}{" "}
            · created {formatDate(account.created_at)}
          </>
        }
        action={<Status value={status} />}
      />
      <section className="metrics detail-metrics">
        <Metric
          label="Accepted"
          value={totals.accepted}
          note="messages, all time"
          color="green"
        />
        <Metric
          label="Delivered"
          value={totals.delivered}
          note="confirmed by provider"
          color="lime"
        />
        <Metric
          label="Bounced"
          value={totals.bounced}
          note="hard and soft"
          color="blue"
        />
        <Metric
          label="Complaints"
          value={totals.complained}
          note="marked as spam"
          color="warn"
        />
      </section>
      <section className="split">
        <div>
          <Card title="Lifecycle">
            <p className="card-note">
              Suspending stops sending immediately at the provider. Resuming
              re-activates the sub-account and restarts paused campaigns.
              Re-running setup resumes provisioning from its last completed
              step.
            </p>
            <div className="button-row">
              {status === "SUSPENDED" ? (
                <Action
                  label="Resume account"
                  variant="primary"
                  run={() => post("resume").then(accounts.reload)}
                />
              ) : (
                <Action
                  label="Suspend account"
                  variant="secondary"
                  confirmText={`Suspend ${account.name}? Sending stops immediately.`}
                  run={() => post("suspend").then(accounts.reload)}
                />
              )}
              <Action
                label="Re-run setup"
                variant="secondary"
                run={() => post("retry").then(accounts.reload)}
              />
            </div>
          </Card>
          <Card
            title="DNS & tracking"
            action={
              <Action
                label="Verify tracking"
                run={() => post("verify").then(dns.reload)}
              />
            }
          >
            {dns.loading ? (
              <Loading small />
            ) : (
              <DnsTable records={dns.data?.records ?? []} />
            )}
          </Card>
        </div>
        <div>
          <Card title="Plan">
            <p className="card-note">
              Current plan <strong>{String(account.plan_id ?? "—")}</strong>.
              Changing plan updates the monthly sending limit at the provider.
            </p>
            <div className="inline-form">
              <select
                aria-label="Plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              >
                <option value="">Choose a plan…</option>
                {plans.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Action
                label="Assign"
                variant="secondary"
                run={async () => {
                  if (!plan) throw new Error("Choose a plan first");
                  await post("plan", { planId: plan });
                  accounts.reload();
                }}
              />
            </div>
          </Card>
          <Card title="Customer access">
            <p className="card-note">
              Open the customer’s workspace through the reseller’s branded
              hostname. Sign-in links are single-use and expire after 60
              seconds.
            </p>
            <div className="inline-form">
              <input
                type="email"
                aria-label="Customer email"
                placeholder="customer@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Action
                label="Open sign-in link"
                variant="secondary"
                run={async () => {
                  if (!email) throw new Error("Enter the customer’s email");
                  const result = await api<{ url: string }>(`${base}/sso`, {
                    method: "POST",
                    ...jsonBody({ email }),
                  });
                  location.assign(result.url);
                }}
              />
            </div>
            <p className="card-note">
              Support access opens the workspace as its owner. Every session is
              audited with your reason and shown to you in a banner.
            </p>
            <div className="inline-form">
              <input
                aria-label="Reason for support access"
                placeholder="Reason, e.g. ticket #1234"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Action
                label="Start support session"
                variant="secondary"
                run={async () => {
                  if (!reason.trim()) throw new Error("A reason is required");
                  await post("impersonate", { reason });
                  location.assign("/");
                }}
              />
            </div>
          </Card>
          <Card title="Data">
            <p className="card-note">
              Export downloads the account’s contacts, templates and campaign
              history. Deleting removes the account and all of its data
              permanently.
            </p>
            <div className="button-row">
              <a className="secondary" href={`/api${base}/export`}>
                Export data
              </a>
              <Action
                label="Delete account"
                variant="danger"
                confirmText={`Permanently delete ${account.name} and all its data?`}
                run={async () => {
                  await api(base, { method: "DELETE" });
                  go("accounts");
                }}
              />
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}

function ResellersPage({ platform, root, go, id }: Ctx & { id: string }) {
  if (id === "new") return <LinkReseller root={root} go={go} />;
  if (id)
    return <ResellerDetail platform={platform} root={root} go={go} id={id} />;
  return (
    <>
      <PageHeading
        kicker="Resellers"
        title="Resellers"
        text="Each reseller brings its own parent sending account, brand and hostnames. Accounts are provisioned beneath a reseller."
        action={
          <button className="primary" onClick={() => go("resellers/new")}>
            <Icon name="plus" />
            Link reseller
          </button>
        }
      />
      <DataView
        title="All resellers"
        path={root + "/resellers"}
        onSelect={(r) => go(`resellers/${r.id}`)}
        empty={[
          "No resellers yet",
          "Link a reseller’s parent account to get started.",
        ]}
        columns={[
          {
            key: "name",
            label: "Reseller",
            render: (r) => (
              <>
                <strong>{String(r.name)}</strong>
                <small>{String(r.id)}</small>
              </>
            ),
          },
          { key: "status", label: "Status" },
          { key: "plan_id", label: "Plan" },
          { key: "mc_parent_handle", label: "Parent handle" },
          { key: "created_at", label: "Created" },
        ]}
      />
    </>
  );
}

function LinkReseller({ root, go }: { root: string; go: (r: string) => void }) {
  const plans = usePlans(root, "reseller");
  return (
    <>
      <BackLink label="All resellers" onClick={() => go("resellers")} />
      <PageHeading
        kicker="Resellers"
        title="Link reseller"
        text="The parent credentials are validated with the provider before the reseller is created, then stored encrypted."
      />
      <div className="narrow">
        {plans.length ? (
          <Form
            title="Reseller details"
            submitLabel="Link reseller"
            fields={[
              {
                key: "name",
                label: "Reseller name",
                required: true,
                placeholder: "Pilot Hosting",
              },
              {
                key: "planId",
                label: "Plan",
                options: plans,
                value: plans.some((p) => p.value === "reseller")
                  ? "reseller"
                  : "",
                required: true,
              },
              {
                key: "parentHandle",
                label: "Parent account handle",
                required: true,
              },
              {
                key: "apiKey",
                label: "Parent API key",
                type: "password",
                required: true,
              },
            ]}
            submit={(v) =>
              api(root + "/resellers", { method: "POST", ...jsonBody(v) })
            }
            onDone={(result) => {
              const created = (result as { id?: string })?.id;
              go(created ? `resellers/${created}` : "resellers");
            }}
          />
        ) : (
          <Loading small />
        )}
      </div>
    </>
  );
}

function ResellerDetail({ platform, root, go, id }: Ctx & { id: string }) {
  const resellers = useData<{ resellers: Row[] }>(root + "/resellers");
  const accounts = useData<{ accounts: Row[] }>(root + "/accounts");
  const plans = usePlans(root, "reseller");
  if (resellers.loading) return <Loading />;
  const reseller = resellers.data?.resellers.find((r) => r.id === id);
  if (!reseller)
    return (
      <>
        <BackLink label="All resellers" onClick={() => go("resellers")} />
        <Empty
          title="Reseller not found"
          text="Check the link and try again."
        />
      </>
    );
  const base = `${root}/resellers/${id}`;
  return (
    <>
      <BackLink label="All resellers" onClick={() => go("resellers")} />
      <PageHeading
        kicker="Reseller"
        title={String(reseller.name)}
        text={
          <>
            {id} · parent {String(reseller.mc_parent_handle ?? "not linked")} ·
            plan {String(reseller.plan_id ?? "—")} · created{" "}
            {formatDate(reseller.created_at)}
          </>
        }
        action={<Status value={String(reseller.status)} />}
      />
      <Card
        title={
          <CardTitle
            title="Accounts"
            count={
              accounts.data
                ? accounts.data.accounts.filter((a) => a.reseller_id === id)
                    .length
                : undefined
            }
          />
        }
      >
        {accounts.loading ? (
          <Loading small />
        ) : (
          <AccountTable
            rows={(accounts.data?.accounts ?? []).filter(
              (a) => a.reseller_id === id,
            )}
            platform={false}
            go={go}
          />
        )}
      </Card>
      <section className="setup-grid three">
        <Form
          title="Status & plan"
          submitLabel="Update reseller"
          fields={[
            {
              key: "status",
              label: "Status",
              value: String(reseller.status),
              options: [
                { value: "ACTIVE", label: "Active" },
                { value: "SUSPENDED", label: "Suspended" },
              ],
              wide: true,
            },
            {
              key: "planId",
              label: "Plan",
              value: String(reseller.plan_id ?? ""),
              options: plans,
            },
          ]}
          submit={(v) =>
            api(base, {
              method: "PUT",
              ...jsonBody({
                status: v.status || undefined,
                planId: v.planId || undefined,
              }),
            })
          }
          onDone={resellers.reload}
        />
        <Form
          title="System email"
          description="Sign-in links and invitations for this reseller’s customers are sent from this branded address."
          submitLabel="Save system email"
          fields={[
            {
              key: "from",
              label: "Sender address",
              type: "email",
              required: true,
              placeholder: "login@brand.example",
            },
            {
              key: "apiKey",
              label: "Sending key",
              type: "password",
              required: true,
            },
          ]}
          submit={(v) =>
            api(base + "/system-email", { method: "PUT", ...jsonBody(v) })
          }
        />
        <Form
          title="Rotate parent key"
          description="The new key is validated with the provider before it replaces the stored key."
          submitLabel="Rotate key"
          fields={[
            {
              key: "apiKey",
              label: "New parent API key",
              type: "password",
              required: true,
              wide: true,
            },
          ]}
          submit={(v) =>
            api(base + "/mailchannels-key", { method: "PUT", ...jsonBody(v) })
          }
        />
      </section>
      {platform && (
        <>
          <h2 className="section-title">Reseller staff</h2>
          <Users root={base} scope="reseller" />
        </>
      )}
    </>
  );
}

function PlansPage({ root }: Ctx) {
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeading
        kicker="Commercial"
        title="Plans"
        text="Plans set the monthly sending limit, contact allowance and release rate for accounts and resellers."
      />
      <section className="split">
        <DataView
          key={version}
          title="All plans"
          path={root + "/plans"}
          columns={[
            {
              key: "id",
              label: "Plan",
              render: (r) => <strong>{String(r.id)}</strong>,
            },
            {
              key: "scope_type",
              label: "Applies to",
              render: (r) => <Status value={String(r.scope_type)} />,
            },
            { key: "monthly_sends", label: "Sends / month" },
            { key: "contacts", label: "Contacts" },
            { key: "rate", label: "Rate", render: (r) => `${r.rate} msg/s` },
          ]}
        />
        <Form
          title="Create plan"
          submitLabel="Create plan"
          fields={[
            {
              key: "scopeType",
              label: "Applies to",
              required: true,
              value: "account",
              options: [
                { value: "account", label: "Accounts" },
                { value: "reseller", label: "Resellers" },
              ],
              wide: true,
            },
            {
              key: "monthlySends",
              label: "Monthly sends",
              type: "number",
              required: true,
              placeholder: "10000",
            },
            {
              key: "contacts",
              label: "Contacts",
              type: "number",
              required: true,
              placeholder: "10000",
            },
            {
              key: "rate",
              label: "Messages per second",
              type: "number",
              required: true,
              placeholder: "5",
              wide: true,
            },
          ]}
          submit={(v) =>
            api(root + "/plans", {
              method: "POST",
              ...jsonBody({
                ...v,
                monthlySends: Number(v.monthlySends),
                contacts: Number(v.contacts),
                rate: Number(v.rate),
              }),
            })
          }
          onDone={() => setVersion((v) => v + 1)}
        />
      </section>
    </>
  );
}

function UsagePage({ platform, root }: Ctx) {
  const { data, loading, error, reload } = useData<{
    usage: Row[];
    providerUsage: Row[];
  }>(root + "/usage");
  const totals = sumUsage(data?.usage ?? []);
  return (
    <>
      <PageHeading
        kicker="Metering"
        title="Usage"
        text={
          platform
            ? "Daily sending volume for every reseller and account, as recorded for invoicing."
            : "Daily sending volume across your accounts, as recorded for invoicing."
        }
        action={
          <a
            className="secondary"
            href={"/api" + root + "/usage?format=csv"}
            download
          >
            Download usage CSV
          </a>
        }
      />
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox error={error} retry={reload} />
      ) : (
        <>
          <section className="metrics">
            <Metric
              label="Accepted"
              value={totals.accepted}
              note="messages recorded"
              color="green"
            />
            <Metric
              label="Delivered"
              value={totals.delivered}
              note="confirmed by provider"
              color="lime"
            />
            <Metric
              label="Bounced"
              value={totals.bounced}
              note="hard and soft"
              color="blue"
            />
            <Metric
              label="Complaints"
              value={totals.complained}
              note="marked as spam"
              color="warn"
            />
          </section>
          <Card
            title={<CardTitle title="Daily usage" count={data.usage.length} />}
            action={<button onClick={reload}>Refresh</button>}
          >
            <Table
              rows={data.usage}
              empty={[
                "No usage recorded",
                "Daily totals appear after accounts start sending.",
              ]}
              columns={[
                { key: "day", label: "Day" },
                {
                  key: "scope_type",
                  label: "Scope",
                  render: (r) => <Status value={String(r.scope_type)} />,
                },
                {
                  key: "scope_id",
                  label: "ID",
                  render: (r) => <code>{String(r.scope_id)}</code>,
                },
                { key: "accepted", label: "Accepted" },
                { key: "delivered", label: "Delivered" },
                { key: "bounced", label: "Bounced" },
                { key: "complained", label: "Complaints" },
              ]}
            />
          </Card>
          <Card
            title={
              <CardTitle
                title="Provider billing period"
                count={data.providerUsage.length}
              />
            }
          >
            <Table
              rows={data.providerUsage}
              expand={(r) => <Json value={r.provider_usage_json} />}
              empty={[
                "No provider usage yet",
                "Provider-reported totals are collected by maintenance.",
              ]}
              columns={[
                {
                  key: "name",
                  label: "Account",
                  render: (r) => (
                    <>
                      <strong>{String(r.name)}</strong>
                      <small>{String(r.id)}</small>
                    </>
                  ),
                },
                {
                  key: "summary",
                  label: "Reported",
                  render: (r) => (
                    <span className="muted">
                      {summarize(r.provider_usage_json)}
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}

function HealthPage({ root, go }: Ctx) {
  const { data, loading, error, reload } = useData<Record<string, Row[]>>(
    root + "/health",
  );
  const [ran, setRan] = useState("");
  const counts = Object.fromEntries(
    (data?.accounts ?? []).map((r) => [r.status, Number(r.count)]),
  );
  return (
    <>
      <PageHeading
        kicker="Operations"
        title="Health"
        text="Maintenance runs every minute: it retries provisioning, callbacks and system email, and meters usage. Run it now to act immediately."
        action={
          <Action
            label="Run maintenance"
            variant="primary"
            run={async () => {
              await api(root + "/maintenance", { method: "POST" });
              setRan(
                `Maintenance completed at ${new Date().toLocaleTimeString()}`,
              );
              reload();
            }}
          />
        }
      />
      {ran && <p className="notice">{ran}</p>}
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox error={error} retry={reload} />
      ) : (
        <>
          <section className="metrics">
            <Metric
              label="Active accounts"
              value={counts.ACTIVE ?? 0}
              note={`${counts.PROVISIONING ?? 0} provisioning · ${counts.SUSPENDED ?? 0} suspended`}
              color="green"
            />
            <Metric
              label="Open alerts"
              value={data.alerts.length}
              note="awaiting resolution"
              color="warn"
            />
            <Metric
              label="Pending callbacks"
              value={data.callbacks.length}
              note="reseller webhooks in retry"
              color="blue"
            />
            <Metric
              label="Provisioning issues"
              value={data.provisioning.length}
              note="accounts not fully set up"
              color="lime"
            />
          </section>
          <Card
            title={<CardTitle title="Alerts" count={data.alerts.length} />}
            action={<button onClick={reload}>Refresh</button>}
          >
            <Table
              rows={data.alerts}
              expand={(r) => <Json value={r.detail_json} />}
              empty={[
                "No open alerts",
                "Provider, webhook and abuse alerts appear here.",
              ]}
              columns={[
                {
                  key: "kind",
                  label: "Alert",
                  render: (r) => <strong>{humanize(String(r.kind))}</strong>,
                },
                {
                  key: "account_id",
                  label: "Account",
                  render: (r) => accountLink(r.account_id, go),
                },
                { key: "created_at", label: "Raised" },
              ]}
              actions={(row) => (
                <>
                  {row.kind === "unknown_webhook_handle" && (
                    <Action
                      label="Replay event"
                      run={() =>
                        api(root + "/alerts/" + row.id + "/replay", {
                          method: "POST",
                        }).then(reload)
                      }
                    />
                  )}
                  <Action
                    label="Resolve"
                    run={() =>
                      api(root + "/alerts/" + row.id + "/resolve", {
                        method: "POST",
                      }).then(reload)
                    }
                  />
                </>
              )}
            />
          </Card>
          <Card
            title={
              <CardTitle
                title="Provisioning"
                count={data.provisioning.length}
              />
            }
          >
            <Table
              rows={data.provisioning}
              empty={[
                "Provisioning is up to date",
                "Every account has finished setup.",
              ]}
              columns={[
                {
                  key: "account_id",
                  label: "Account",
                  render: (r) => accountLink(r.account_id, go),
                },
                { key: "step", label: "Step" },
                { key: "attempts", label: "Attempts" },
                {
                  key: "error",
                  label: "Last error",
                  render: (r) => (
                    <span className="error-text">{String(r.error ?? "—")}</span>
                  ),
                },
                { key: "next_attempt", label: "Next attempt" },
              ]}
              actions={(row) => (
                <Action
                  label="Retry now"
                  run={() =>
                    api(root + "/accounts/" + row.account_id + "/retry", {
                      method: "POST",
                    }).then(reload)
                  }
                />
              )}
            />
          </Card>
          <section className="split even">
            <Card
              title={
                <CardTitle
                  title="Pending callbacks"
                  count={data.callbacks.length}
                />
              }
            >
              <Table
                rows={data.callbacks}
                empty={[
                  "No pending callbacks",
                  "Reseller webhooks are delivered.",
                ]}
                columns={[
                  {
                    key: "type",
                    label: "Event",
                    render: (r) => <strong>{String(r.type)}</strong>,
                  },
                  { key: "reseller_id", label: "Reseller" },
                  { key: "attempts", label: "Attempts" },
                  { key: "next_attempt", label: "Next attempt" },
                ]}
                actions={(row) => (
                  <Action
                    label="Retry"
                    run={() =>
                      api(root + "/callbacks/" + row.id + "/retry", {
                        method: "POST",
                      }).then(reload)
                    }
                  />
                )}
              />
            </Card>
            <Card
              title={
                <CardTitle
                  title="Pending system email"
                  count={data.systemEmail.length}
                />
              }
            >
              <p className="card-note">
                Expired invitations can be resent from staff management.
              </p>
              <Table
                rows={data.systemEmail}
                empty={[
                  "No pending system email",
                  "Sign-in links and invitations are sent.",
                ]}
                columns={[
                  {
                    key: "recipient",
                    label: "Recipient",
                    render: (r) => (
                      <>
                        <strong>{String(r.recipient)}</strong>
                        <small>{String(r.subject ?? "")}</small>
                      </>
                    ),
                  },
                  { key: "reseller_id", label: "Reseller" },
                  { key: "attempts", label: "Attempts" },
                ]}
              />
            </Card>
          </section>
          <div className="narrow">
            <Form
              title="Abuse response"
              description="Suspend an account’s sending immediately at the provider while a complaint or abuse report is investigated."
              submitLabel="Suspend sender"
              secondary
              fields={[
                {
                  key: "id",
                  label: "Account ID",
                  required: true,
                  placeholder: "account-…",
                  wide: true,
                },
              ]}
              submit={(v) =>
                api(root + "/abuse/" + encodeURIComponent(v.id) + "/suspend", {
                  method: "POST",
                })
              }
            />
          </div>
        </>
      )}
    </>
  );
}

function FailedJobsPage({ root, go }: Ctx) {
  return (
    <>
      <PageHeading
        kicker="Operations"
        title="Failed jobs"
        text="Queue messages that exhausted their retries. Inspect the payload, fix the cause, then replay."
      />
      <DataView
        title="Dead-letter queue"
        path={root + "/dead-letters"}
        expand={(r) => <Json value={r.body_json} />}
        empty={["No failed jobs", "Every queued job has completed."]}
        columns={[
          {
            key: "queue",
            label: "Queue",
            render: (r) => <strong>{String(r.queue)}</strong>,
          },
          {
            key: "account_id",
            label: "Account",
            render: (r) => accountLink(r.account_id, go),
          },
          {
            key: "error",
            label: "Error",
            render: (r) => (
              <span className="error-text">{String(r.error ?? "—")}</span>
            ),
          },
          { key: "created_at", label: "Failed" },
          { key: "replayed_at", label: "Replayed" },
        ]}
        actions={(row, reload) =>
          row.replayed_at ? (
            <Status value="replayed" />
          ) : (
            <Action
              label="Replay"
              run={() =>
                api(root + "/dead-letters/" + row.id + "/replay", {
                  method: "POST",
                }).then(reload)
              }
            />
          )
        }
      />
    </>
  );
}

function SearchPage({ root, go }: Ctx) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useData<{ accounts: Row[]; resellers: Row[] }>(
    debounced ? root + "/search?q=" + encodeURIComponent(debounced) : "",
  );
  return (
    <>
      <PageHeading
        kicker="Lookup"
        title="Search"
        text="Find any account or reseller by name or ID."
      />
      <div className="search-hero">
        <Icon name="search" />
        <input
          autoFocus
          aria-label="Global search"
          placeholder="Search accounts and resellers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {debounced &&
        (results.loading ? (
          <Loading small />
        ) : results.error ? (
          <ErrorBox error={results.error} retry={results.reload} />
        ) : (
          <section className="split even">
            <Card
              title={
                <CardTitle
                  title="Accounts"
                  count={results.data?.accounts.length ?? 0}
                />
              }
            >
              <Table
                rows={results.data?.accounts ?? []}
                onSelect={(r) => go(`accounts/${r.id}`)}
                empty={["No matching accounts", "Try a different name or ID."]}
                columns={[
                  {
                    key: "name",
                    label: "Account",
                    render: (r) => (
                      <>
                        <strong>{String(r.name)}</strong>
                        <small>{String(r.id)}</small>
                      </>
                    ),
                  },
                  { key: "reseller_id", label: "Reseller" },
                  { key: "status", label: "Status" },
                ]}
              />
            </Card>
            <Card
              title={
                <CardTitle
                  title="Resellers"
                  count={results.data?.resellers.length ?? 0}
                />
              }
            >
              <Table
                rows={results.data?.resellers ?? []}
                onSelect={(r) => go(`resellers/${r.id}`)}
                empty={["No matching resellers", "Try a different name or ID."]}
                columns={[
                  {
                    key: "name",
                    label: "Reseller",
                    render: (r) => (
                      <>
                        <strong>{String(r.name)}</strong>
                        <small>{String(r.id)}</small>
                      </>
                    ),
                  },
                  { key: "status", label: "Status" },
                ]}
              />
            </Card>
          </section>
        ))}
    </>
  );
}

function HostnamesPage({ platform, root }: Ctx) {
  const resellers = useResellerOptions(platform);
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeading
        kicker="Domains"
        title="Hostnames"
        text="Branded hostnames serve the customer workspace under a reseller’s own domain. Point the hostname at the service, then verify it."
      />
      <section className="split">
        <DataView
          key={version}
          title="Hostnames"
          path={root + "/hostnames"}
          expand={(r) => (
            <Json value={r.verification_json ?? "Not verified yet"} />
          )}
          empty={[
            "No hostnames",
            "Add a hostname to serve a branded workspace.",
          ]}
          columns={[
            {
              key: "hostname",
              label: "Hostname",
              render: (r) => <strong>{String(r.hostname)}</strong>,
            },
            ...(platform ? [{ key: "reseller_id", label: "Reseller" }] : []),
            { key: "status", label: "Status" },
            { key: "verified_at", label: "Verified" },
          ]}
          actions={(row, reload) => (
            <Action
              label="Verify"
              run={() =>
                api(root + "/hostnames/" + row.hostname, {
                  method: "POST",
                }).then(reload)
              }
            />
          )}
        />
        {!platform || resellers.length > 0 ? (
          <Form
            title="Add hostname"
            description="Click a hostname in the list to see its verification details."
            submitLabel="Add hostname"
            fields={[
              {
                key: "hostname",
                label: "Hostname",
                required: true,
                placeholder: "mail.brand.example",
                wide: true,
              },
              ...(platform
                ? [
                    {
                      key: "resellerId",
                      label: "Reseller",
                      options: resellers,
                      required: true,
                      wide: true,
                    },
                  ]
                : []),
            ]}
            submit={(v) =>
              api(root + "/hostnames", { method: "POST", ...jsonBody(v) })
            }
            onDone={() => setVersion((v) => v + 1)}
          />
        ) : (
          <Card title="Add hostname">
            <Loading small />
          </Card>
        )}
      </section>
    </>
  );
}

function Branding() {
  const current = useData<{
    theme: Record<string, string>;
    logo: boolean;
    favicon: boolean;
  }>("/reseller/theme");
  const [uploaded, setUploaded] = useState("");
  const theme = current.data?.theme ?? {};
  return (
    <>
      <PageHeading
        kicker="White label"
        title="Branding"
        text="Your customers see this name, logo and colour scheme on every branded hostname and in system email."
      />
      {current.loading ? (
        <Loading />
      ) : (
        <section className="split">
          <Form
            title="Theme"
            submitLabel="Save theme"
            fields={[
              {
                key: "productName",
                label: "Product name",
                value: theme.productName ?? "Email Studio",
                required: true,
                wide: true,
              },
              {
                key: "primary",
                label: "Primary color",
                type: "color",
                value: theme.primary ?? "#35a047",
              },
              {
                key: "background",
                label: "Background",
                type: "color",
                value: theme.background ?? "#ffffff",
              },
              {
                key: "text",
                label: "Text",
                type: "color",
                value: theme.text ?? "#070a30",
              },
              {
                key: "font",
                label: "Font",
                value: theme.font ?? "Roboto",
                options: [
                  "Roboto",
                  "system-ui",
                  "Arial",
                  "Georgia",
                  "Verdana",
                  "monospace",
                ],
              },
              {
                key: "radius",
                label: "Corner radius",
                hint: "0–30px",
                value: theme.radius ?? "8px",
              },
              {
                key: "supportLink",
                label: "Support URL",
                hint: "https only",
                value: theme.supportLink ?? "",
                placeholder: "https://help.brand.example",
              },
              {
                key: "css",
                label: "Custom CSS",
                hint: "optional, sanitised",
                type: "textarea",
                wide: true,
              },
            ]}
            submit={(v) => {
              const { css, ...tokens } = v;
              return api("/reseller/theme", {
                method: "PUT",
                ...jsonBody({ tokens, css }),
              });
            }}
            onDone={() => location.reload()}
          />
          <Card title="Logo & favicon">
            <p className="card-note">
              PNG or JPEG. Changes apply on the next page load.
            </p>
            {(["logo", "favicon"] as const).map((kind) => (
              <label className="dropzone compact" key={kind}>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      await api("/reseller/theme/" + kind, {
                        method: "PUT",
                        body: file,
                        headers: { "content-type": file.type },
                      });
                      setUploaded(`${capitalize(kind)} uploaded.`);
                      current.reload();
                    } catch (error) {
                      setUploaded(message(error));
                    }
                  }}
                />
                <span>
                  <Icon name="upload" size={20} stroke={1.5} />
                </span>
                <strong>Upload {kind}</strong>
                <small>
                  {current.data?.[kind]
                    ? "Currently set · choose a file to replace"
                    : "Not set"}
                </small>
              </label>
            ))}
            {uploaded && <p className="notice">{uploaded}</p>}
          </Card>
        </section>
      )}
    </>
  );
}

function Integrations() {
  const settings = useData<{ tracking_pattern?: string; webhook_url?: string }>(
    "/reseller/settings",
  );
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeading
        kicker="Developers"
        title="Integrations"
        text="Connect your billing system and identity provider: API keys, event webhooks, single sign-on and click tracking."
      />
      <section className="split">
        <DataView
          key={version}
          title="API keys"
          path="/reseller/api-keys"
          empty={[
            "No API keys",
            "Create a key to manage accounts from your own systems.",
          ]}
          columns={[
            {
              key: "id",
              label: "Key",
              render: (r) => <code>{String(r.id)}</code>,
            },
            {
              key: "scopes",
              label: "Permissions",
              render: (r) => (
                <span className="muted">{scopesOf(r.scopes)}</span>
              ),
            },
            { key: "last_used_at", label: "Last used" },
            {
              key: "revoked_at",
              label: "Status",
              render: (r) => (
                <Status value={r.revoked_at ? "revoked" : "active"} />
              ),
            },
          ]}
          actions={(r, reload) =>
            !r.revoked_at && (
              <Action
                label="Revoke"
                variant="danger"
                confirmText="Revoke this key? Integrations using it stop working immediately."
                run={() =>
                  api("/reseller/api-keys/" + r.id, { method: "DELETE" }).then(
                    reload,
                  )
                }
              />
            )
          }
        />
        <Form
          title="Create API key"
          submitLabel="Create key"
          resultNote="Copy the key now. It will not be shown again."
          fields={[
            {
              key: "scopes",
              label: "Permissions",
              hint: "comma-separated",
              value: "accounts.read,accounts.manage,usage.read,sso.mint",
              wide: true,
            },
          ]}
          submit={(v) =>
            api("/reseller/api-keys", {
              method: "POST",
              ...jsonBody({
                scopes: v.scopes
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              }),
            })
          }
          onDone={() => setVersion((v) => v + 1)}
        />
      </section>
      <section className="setup-grid three">
        {settings.loading ? (
          <Card title="Event delivery">
            <Loading small />
          </Card>
        ) : (
          <Form
            title="Event delivery"
            description="Account lifecycle events are signed and posted to your webhook. Tracking links use your pattern."
            submitLabel="Save settings"
            fields={[
              {
                key: "trackingPattern",
                label: "Tracking hostname pattern",
                value:
                  settings.data?.tracking_pattern ??
                  "{account}.links.example.com",
                wide: true,
              },
              {
                key: "webhookUrl",
                label: "Event webhook URL",
                value: settings.data?.webhook_url ?? "",
                placeholder: "https://billing.example.com/hooks",
                wide: true,
              },
              {
                key: "systemEmailFrom",
                label: "System email sender",
                type: "email",
                placeholder: "login@brand.example",
              },
              {
                key: "systemEmailKey",
                label: "System sending key",
                type: "password",
              },
            ]}
            submit={(v) =>
              api("/reseller/settings", { method: "PUT", ...jsonBody(v) })
            }
          />
        )}
        <Form
          title="Organization sign-in"
          description="Let your staff sign in with your OpenID Connect identity provider."
          submitLabel="Save sign-in"
          fields={[
            {
              key: "issuer",
              label: "OIDC issuer",
              placeholder: "https://login.example.com",
              wide: true,
            },
            { key: "clientId", label: "Client ID" },
            { key: "clientSecret", label: "Client secret", type: "password" },
          ]}
          submit={(v) =>
            api("/reseller/oidc", { method: "PUT", ...jsonBody(v) })
          }
        />
        <Form
          title="Rotate integration secret"
          description="Issue a new secret for signing SSO hand-offs or verifying webhooks. The old secret stops working."
          submitLabel="Rotate secret"
          resultNote="Copy the new secret now. It will not be shown again."
          fields={[
            {
              key: "kind",
              label: "Secret",
              required: true,
              wide: true,
              options: [
                { value: "sso", label: "SSO signing secret" },
                { value: "webhook", label: "Webhook signing secret" },
              ],
            },
          ]}
          submit={(v) =>
            api("/reseller/integration-secret", {
              method: "POST",
              ...jsonBody(v),
            })
          }
        />
      </section>
    </>
  );
}

/* ---------- helpers ---------- */

function cell(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "")
    return <span className="muted">—</span>;
  if (key === "status" || key === "step")
    return <Status value={String(value)} />;
  if (/_at$|^next_attempt$/.test(key)) return formatDate(value);
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "object") return <code>{JSON.stringify(value)}</code>;
  return String(value);
}

function accountLink(id: unknown, go: (r: string) => void) {
  if (!id) return <span className="muted">—</span>;
  return (
    <button
      className="link-button"
      onClick={(e) => {
        e.stopPropagation();
        go(`accounts/${id}`);
      }}
    >
      {String(id)}
    </button>
  );
}

function sumUsage(rows: Row[]) {
  const totals = { accepted: 0, delivered: 0, bounced: 0, complained: 0 };
  for (const row of rows)
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] += Number(row[key] ?? 0);
  return totals;
}

function summarize(json: unknown) {
  try {
    const value = JSON.parse(String(json));
    return Object.entries(value)
      .filter(([, v]) => typeof v !== "object")
      .slice(0, 3)
      .map(([k, v]) => `${humanize(k)}: ${v}`)
      .join(" · ");
  } catch {
    return String(json ?? "—");
  }
}

function scopesOf(value: unknown) {
  try {
    const list = JSON.parse(String(value));
    return Array.isArray(list) ? list.join(", ") : String(value);
  } catch {
    return String(value);
  }
}

function parseList(value: unknown): Row[] {
  try {
    const list = JSON.parse(String(value ?? "[]"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function humanize(key: string) {
  return capitalize(key.replaceAll("_", " ").replace(/^mc /, "parent "));
}

function isOk(value: Row) {
  return Object.keys(value).length === 1 && value.ok === true;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
