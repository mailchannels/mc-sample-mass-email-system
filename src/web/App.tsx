import { Portal, AccountSettings } from "./Console";
import {
  CSSProperties,
  FormEvent,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, jsonBody } from "./api";
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
  formatBytes,
  formatDate,
  formatNumber,
  productTheme,
  useData,
  type NavItem,
  type Row,
} from "./ui";

const nav: NavItem[] = [
  { key: "dashboard", label: "Overview", icon: "overview" },
  { key: "campaigns", label: "Campaigns", icon: "activity" },
  { key: "new-campaign", label: "New campaign", icon: "plus" },
  { key: "templates", label: "Templates", icon: "file" },
  { key: "recipients", label: "Recipient lists", icon: "users" },
  { key: "send", label: "Test email", icon: "send" },
  { key: "settings", label: "Settings & users", icon: "sliders" },
];

export function App() {
  return <Portal />;
}

export function CustomerApp() {
  const me = useContext(SessionContext);
  const [route, setRoute] = useState(
    () => location.hash.slice(1) || "dashboard",
  );
  useEffect(() => {
    const changed = () => setRoute(location.hash.slice(1) || "dashboard");
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  const page = route.split("?")[0];
  const go = (next: string) => {
    location.hash = next;
  };
  const { productName } = productTheme();
  return (
    <Shell
      name={productName ?? "Email Studio"}
      tagline="Email marketing"
      nav={nav}
      active={page}
      href={(key) => "#" + key}
      links={
        !me?.impersonating &&
        me?.roles.some((r) => r.scope_type === "reseller") && (
          <a className="pill" href="#reseller">
            Reseller console
          </a>
        )
      }
    >
      {page === "dashboard" && <Dashboard go={go} />}
      {page === "campaigns" && <Campaigns route={route} go={go} />}
      {page === "new-campaign" && <NewCampaign go={go} />}
      {page === "templates" && <Templates />}
      {page === "recipients" && <Recipients />}
      {page === "send" && <Adhoc />}
      {page === "settings" && <AccountSettings />}
    </Shell>
  );
}

function Dashboard({ go }: { go: (route: string) => void }) {
  const { data, loading, error, reload } = useData<{
    campaigns: number;
    recipients: number;
    templates: number;
    delivery: Row;
  }>("/dashboard");
  const recent = useData<{ campaigns: Row[] }>("/campaigns?limit=5", 15000);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} retry={reload} />;
  const delivered = Number(data.delivery.delivered ?? 0),
    bounced = Number(data.delivery.bounced ?? 0),
    failed = Number(data.delivery.failed ?? 0);
  const total = delivered + bounced + failed;
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>Send at scale. See every outcome.</h1>
          <p>
            Create campaigns, reach your audience, and follow every delivery as
            it happens.
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={() => go("new-campaign")}>
              <Icon name="plus" />
              New campaign
            </button>
            <button className="secondary" onClick={() => go("campaigns")}>
              View live activity
            </button>
          </div>
        </div>
        <DeliveryPanel
          value={total ? Math.round((delivered / total) * 100) : 100}
          delivered={delivered}
          total={total}
        />
      </section>
      <section className="metrics">
        <Metric
          label="Campaigns"
          value={data.campaigns}
          note="all time"
          color="green"
        />
        <Metric
          label="Recipients"
          value={data.recipients}
          note="across uploaded lists"
          color="blue"
        />
        <Metric
          label="Templates"
          value={data.templates}
          note="Mustache-ready"
          color="lime"
        />
        <Metric
          label="Accepted outcomes"
          value={total}
          note={`${delivered} delivered · ${bounced + failed} exceptions`}
          color="warn"
        />
      </section>
      <section className="split">
        <Card
          title="Recent campaigns"
          action={<button onClick={() => go("campaigns")}>View all →</button>}
        >
          <CampaignTable
            rows={recent.data?.campaigns ?? []}
            onSelect={(id) => go(`campaigns?id=${id}`)}
            compact
          />
        </Card>
        <Card title="Get started">
          <div className="checklist">
            {[
              [
                "settings",
                "1",
                "Verify your sender",
                "Add a postal address and sender domain in Settings.",
              ],
              [
                "recipients",
                "2",
                "Upload an audience",
                "Import a consented CSV into a recipient list.",
              ],
              [
                "templates",
                "3",
                "Prepare a template",
                "Write the message once, personalise with Mustache.",
              ],
              [
                "new-campaign",
                "4",
                "Launch a campaign",
                "Pick a list and template, then follow delivery live.",
              ],
            ].map(([route, step, title, text]) => (
              <button key={route} onClick={() => go(route)}>
                <span>{step}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </div>
                <b>→</b>
              </button>
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}

function DeliveryPanel({
  value,
  delivered,
  total,
}: {
  value: number;
  delivered: number;
  total: number;
}) {
  return (
    <div className="delivery-panel">
      <div
        className="ring"
        style={{ "--value": value } as CSSProperties}
        role="img"
        aria-label={`Delivery rate ${value}%`}
      >
        <b>{value}%</b>
      </div>
      <div>
        <strong>Delivery rate</strong>
        <p>
          {total
            ? `${formatNumber(delivered)} of ${formatNumber(total)} accepted messages delivered.`
            : "Delivery outcomes appear here once your first campaign sends."}
        </p>
      </div>
    </div>
  );
}

function Campaigns({
  route,
  go,
}: {
  route: string;
  go: (route: string) => void;
}) {
  const id = new URLSearchParams(route.split("?")[1] ?? "").get("id");
  return id ? (
    <CampaignDetail id={id} back={() => go("campaigns")} />
  ) : (
    <CampaignList go={go} />
  );
}

function CampaignList({ go }: { go: (route: string) => void }) {
  const { data, loading, error, reload } = useData<{ campaigns: Row[] }>(
    "/campaigns?limit=100",
    15000,
  );
  return (
    <>
      <PageHeading
        kicker="Campaigns"
        title="Campaign monitor"
        text="Every campaign remains visible after queue execution finishes, with detailed delivery reports."
        action={
          <button className="primary" onClick={() => go("new-campaign")}>
            New campaign <span>+</span>
          </button>
        }
      />
      <Card>
        {loading ? (
          <Loading small />
        ) : error ? (
          <ErrorBox error={error} retry={reload} />
        ) : (
          <CampaignTable
            rows={data?.campaigns ?? []}
            onSelect={(campaignId) => go(`campaigns?id=${campaignId}`)}
          />
        )}
      </Card>
    </>
  );
}

function CampaignTable({
  rows,
  onSelect,
  compact = false,
}: {
  rows: Row[];
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  if (!rows.length)
    return (
      <Empty
        title="No campaigns yet"
        text="Your first launch will appear here with live send and delivery totals."
      />
    );
  return (
    <div className="table-wrap">
      <table className="clickable">
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Status</th>
            <th>Progress</th>
            {!compact && (
              <>
                <th>Delivered</th>
                <th>Exceptions</th>
              </>
            )}
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const total = Number(row.total_count ?? 0),
              pending = Number(row.pending_count ?? 0),
              accepted = Number(row.accepted_count ?? 0),
              failed = Number(row.failed_count ?? 0);
            const progress = total
              ? Math.round(((accepted + failed) / total) * 100)
              : 0;
            return (
              <tr key={String(row.id)} onClick={() => onSelect(String(row.id))}>
                <td>
                  <strong>{String(row.name || row.id)}</strong>
                  <small>{String(row.template_name ?? "")}</small>
                </td>
                <td>
                  <Status value={String(row.status)} />
                </td>
                <td>
                  <div className="progress">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <small>
                    {progress}% · {pending} pending
                  </small>
                </td>
                {!compact && (
                  <>
                    <td>{formatNumber(Number(row.delivered_count ?? 0))}</td>
                    <td>
                      {formatNumber(Number(row.bounced_count ?? 0) + failed)}
                    </td>
                  </>
                )}
                <td>{formatDate(row.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CampaignDetail({ id, back }: { id: string; back: () => void }) {
  const [search, setSearch] = useState("");
  const path = `/campaigns/${encodeURIComponent(id)}?limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`;
  const { data, loading, error, reload } = useData<{
    campaign: Row;
    batches: Row[];
    recipients: Row[];
  }>(path, 10000);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error} retry={reload} />;
  const c = data.campaign;
  return (
    <>
      <BackLink label="All campaigns" onClick={back} />
      <PageHeading
        kicker="Campaign"
        title={String(c.name || c.id)}
        text={`${String(c.list_name)} · ${String(c.template_name)} · ${String(c.sender_email)}`}
        action={<Status value={String(c.status)} />}
      />
      <section className="metrics detail-metrics">
        <Metric
          label="Accepted"
          value={Number(c.accepted_count)}
          note={`${Number(c.pending_count)} pending`}
          color="green"
        />
        <Metric
          label="Delivered"
          value={Number(c.delivered_count)}
          note="recipient server accepted"
          color="lime"
        />
        <Metric
          label="Bounced"
          value={Number(c.bounced_count)}
          note="hard delivery failures"
          color="warn"
        />
        <Metric
          label="Engaged"
          value={Number(c.opened_count) + Number(c.clicked_count)}
          note={`${Number(c.opened_count)} opens · ${Number(c.clicked_count)} clicks`}
          color="blue"
        />
      </section>
      <section className="split wide-left">
        <Card
          title="Recipient events"
          action={
            <input
              className="search"
              placeholder="Search all recipients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          }
        >
          <RecipientTable rows={data.recipients} />
        </Card>
        <Card title="Batches">
          <BatchList rows={data.batches} />
        </Card>
      </section>
    </>
  );
}

function RecipientTable({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return (
      <Empty
        title="No matching recipients"
        text="Campaign expansion may still be preparing the delivery ledger."
      />
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last update</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              <td>
                <strong>{String(row.email)}</strong>
                <small>
                  {String(row.mailchannels_request_id ?? "Awaiting request ID")}
                </small>
              </td>
              <td>
                <Status value={String(row.status)} />
              </td>
              <td>{String(row.attempts)}</td>
              <td>{formatDate(row.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchList({ rows }: { rows: Row[] }) {
  return (
    <div className="batch-list">
      {rows.length ? (
        rows.map((row) => (
          <div key={String(row.id)}>
            <span>{String(row.sequence).padStart(2, "0")}</span>
            <div>
              <strong>Batch {String(row.sequence)}</strong>
              <small>
                {formatNumber(Number(row.recipient_count))} recipients
              </small>
            </div>
            <Status value={String(row.status)} />
          </div>
        ))
      ) : (
        <Empty
          title="Preparing batches"
          text="Your campaign is being prepared."
        />
      )}
    </div>
  );
}

function NewCampaign({ go }: { go: (route: string) => void }) {
  const lists = useData<{ recipientLists: Row[] }>("/recipients-lists", 5000);
  const templates = useData<{ templates: Row[] }>("/templates");
  const topics = useData<{ topics: string[] }>("/topics");
  const [form, setForm] = useState({
    name: "",
    recipientListId: "",
    templateName: "",
    senderEmail: "",
    senderName: "",
    replyTo: "",
    topic: "",
    transactional: false,
    enableTracking: false,
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const set = (key: string, value: string | boolean) =>
    setForm((old) => ({ ...old, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ campaignId: string }>("/campaigns", {
        method: "POST",
        ...jsonBody({
          ...form,
          replyTo: form.replyTo || undefined,
          topic: form.topic || undefined,
          attachmentIds: [],
        }),
      });
      go(`campaigns?id=${result.campaignId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        kicker="Campaigns"
        title="Launch a campaign"
        text="Send a personalized message to each eligible contact. Unsubscribed contacts are excluded automatically."
      />
      <form className="campaign-form" onSubmit={submit}>
        <Card title="01 · Audience">
          <div className="form-grid">
            <Field label="Campaign name">
              <input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="September product update"
              />
            </Field>
            <Field label="Recipient list">
              <select
                required
                value={form.recipientListId}
                onChange={(e) => set("recipientListId", e.target.value)}
              >
                <option value="">Select a ready list</option>
                {lists.data?.recipientLists
                  .filter((r) => r.status === "READY")
                  .map((r) => (
                    <option value={String(r.id)} key={String(r.id)}>
                      {String(r.name)} ·{" "}
                      {formatNumber(Number(r.recipient_count))}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Topic filter" hint="Optional CSV topic">
              <select
                value={form.topic}
                onChange={(e) => set("topic", e.target.value)}
              >
                <option value="">All eligible recipients</option>
                {topics.data?.topics.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
          </div>
        </Card>
        <Card title="02 · Message">
          <div className="form-grid">
            <Field label="Template">
              <select
                required
                value={form.templateName}
                onChange={(e) => set("templateName", e.target.value)}
              >
                <option value="">Select a template</option>
                {templates.data?.templates.map((r) => (
                  <option key={String(r.name)}>{String(r.name)}</option>
                ))}
              </select>
            </Field>
            <Field label="From email">
              <input
                required
                type="email"
                value={form.senderEmail}
                onChange={(e) => set("senderEmail", e.target.value)}
                placeholder="news@example.com"
              />
            </Field>
            <Field label="From name">
              <input
                value={form.senderName}
                onChange={(e) => set("senderName", e.target.value)}
                placeholder="AnyCompany"
              />
            </Field>
            <Field label="Reply-to">
              <input
                type="email"
                value={form.replyTo}
                onChange={(e) => set("replyTo", e.target.value)}
                placeholder="support@example.com"
              />
            </Field>
          </div>
        </Card>
        <Card title="03 · Delivery policy">
          <div className="toggles">
            <p>
              Every campaign includes a postal address and one-click
              unsubscribe.
            </p>
            <Toggle
              checked={form.enableTracking}
              onChange={(value) => set("enableTracking", value)}
              title="Open and click tracking"
              text="Enabled only after your tracking domain is verified."
            />
          </div>
        </Card>
        {message && <div className="form-error">{message}</div>}
        <div className="launch">
          <p>
            Campaign launch is asynchronous and can safely return before fan-out
            finishes.
          </p>
          <button className="primary" disabled={busy}>
            {busy ? "Launching…" : "Launch campaign"}
          </button>
        </div>
      </form>
    </>
  );
}

function Templates() {
  const state = useData<{ templates: Row[] }>("/templates");
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState({
      name: "",
      subject: "",
      text: "",
      html: "",
    }),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const edit = (row?: Row) => {
    setEditing(row ?? {});
    setForm({
      name: String(row?.name ?? ""),
      subject: String(row?.subject ?? ""),
      text: String(row?.text_body ?? ""),
      html: String(row?.html_body ?? ""),
    });
    setMessage("");
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const updating = Boolean(editing?.name);
      await api(
        `/templates${updating ? `/${encodeURIComponent(String(editing!.name))}` : ""}`,
        { method: updating ? "PUT" : "POST", ...jsonBody(form) },
      );
      setEditing(null);
      state.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(name: string) {
    if (!confirm(`Delete template “${name}”?`)) return;
    try {
      await api(`/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
      state.reload();
    } catch (error) {
      alert(String(error));
    }
  }
  return (
    <>
      <PageHeading
        kicker="Content"
        title="Mustache templates"
        text="Personalize messages with fields such as {{firstName}} and {{unsubscribe_url}}."
        action={
          <button className="primary" onClick={() => edit()}>
            New template +
          </button>
        }
      />
      {editing && (
        <form className="editor" onSubmit={save}>
          <Card
            title={editing.name ? `Edit · ${editing.name}` : "New template"}
          >
            <div className="form-grid">
              <Field label="Template name">
                <input
                  required
                  disabled={Boolean(editing.name)}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Subject">
                <input
                  required
                  value={form.subject}
                  onChange={(e) =>
                    setForm({ ...form, subject: e.target.value })
                  }
                  placeholder="Hello {{firstName}}"
                />
              </Field>
            </div>
            <div className="editor-grid">
              <Field label="Plain text">
                <textarea
                  value={form.text}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  rows={14}
                />
              </Field>
              <Field label="HTML">
                <textarea
                  value={form.html}
                  onChange={(e) => setForm({ ...form, html: e.target.value })}
                  rows={14}
                />
              </Field>
            </div>
            {message && <div className="form-error">{message}</div>}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save template"}
              </button>
            </div>
          </Card>
        </form>
      )}
      <div className="template-grid">
        {state.data?.templates.map((row) => (
          <article className="template-card" key={String(row.name)}>
            <div>
              <span>
                <Icon name="file" size={17} stroke={1.5} />
              </span>
              <Status value="READY" />
            </div>
            <h3>{String(row.name)}</h3>
            <p>{String(row.subject)}</p>
            <small>Updated {formatDate(row.updated_at)}</small>
            <div>
              <button onClick={() => edit(row)}>Edit</button>
              <button onClick={() => remove(String(row.name))}>Delete</button>
            </div>
          </article>
        ))}
        {!state.loading && !state.data?.templates.length && (
          <Empty
            title="No templates"
            text="Create a Mustache-ready message to launch a campaign."
          />
        )}
      </div>
    </>
  );
}

function Recipients() {
  const state = useData<{ recipientLists: Row[] }>("/recipients-lists", 5000);
  const attachments = useData<{ attachments: Row[] }>("/attachments", 5000);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function upload(file: File) {
    if (!confirm("I confirm that these contacts consented to marketing email."))
      return;
    setBusy(true);
    setMessage("");
    try {
      const ticket = await api<{ uploadUrl: string }>(
        `/generate-upload-url?consent=true&filename=${encodeURIComponent(file.name)}`,
      );
      const response = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type || "text/csv" },
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ||
            "Upload failed",
        );
      setMessage(
        "Upload accepted. The list will become ready as queue workers import it.",
      );
      state.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!confirm("Delete this recipient list and its source CSV?")) return;
    try {
      await api(`/recipients-lists/${id}`, { method: "DELETE" });
      state.reload();
    } catch (error) {
      alert(String(error));
    }
  }
  return (
    <>
      <PageHeading
        kicker="Audience"
        title="Recipient lists"
        text="Upload a CSV to create your audience. Headers can include email, first_name, last_name, topics, and arbitrary template data."
      />
      <label className={`dropzone ${busy ? "busy" : ""}`}>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <span>
          <Icon name="upload" size={20} stroke={1.5} />
        </span>
        <strong>
          {busy ? "Uploading…" : "Drop a CSV here or choose a file"}
        </strong>
        <small>Queued, resumable import · up to 95 MB in this sample</small>
      </label>
      {message && (
        <div className={message.includes("accepted") ? "notice" : "form-error"}>
          {message}
        </div>
      )}
      <Card title="Lists">
        {state.loading ? (
          <Loading small />
        ) : !state.data?.recipientLists.length ? (
          <Empty
            icon="users"
            title="No recipient lists yet"
            text="Upload a CSV above; each import becomes a list you can send to."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>List</th>
                  <th>Status</th>
                  <th>Recipients</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.data?.recipientLists.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <strong>{String(row.name)}</strong>
                      <small>{String(row.original_filename)}</small>
                    </td>
                    <td>
                      <Status value={String(row.status)} />
                    </td>
                    <td>{formatNumber(Number(row.recipient_count))}</td>
                    <td>{formatDate(row.created_at)}</td>
                    <td>
                      <button
                        className="text-danger"
                        onClick={() => remove(String(row.id))}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <AttachmentManager state={attachments} />
    </>
  );
}

function AttachmentManager({
  state,
}: {
  state: ReturnType<typeof useData<{ attachments: Row[] }>>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function upload(file: File) {
    setBusy(true);
    setMessage("");
    try {
      const ticket = await api<{ uploadUrl: string }>(
        "/attachments/upload-url",
        {
          method: "POST",
          ...jsonBody({
            filename: file.name,
            contentType: file.type || "application/octet-stream",
          }),
        },
      );
      const response = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" },
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ||
            "Upload failed",
        );
      setMessage("Attachment stored securely.");
      state.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(attachmentId: string) {
    if (!confirm("Delete this attachment?")) return;
    try {
      await api(`/attachments/${attachmentId}`, { method: "DELETE" });
      state.reload();
    } catch (error) {
      alert(String(error));
    }
  }
  return (
    <Card
      title="Attachment library"
      action={
        <label className="upload-button">
          {busy ? "Uploading…" : "Upload file +"}
          <input
            type="file"
            disabled={busy}
            onChange={(event) =>
              event.target.files?.[0] && upload(event.target.files[0])
            }
          />
        </label>
      }
    >
      <p className="card-note">
        Attachments are available for test messages only, up to 20 MB per
        message.
      </p>
      {message && (
        <div
          className={message.startsWith("Attachment") ? "notice" : "form-error"}
        >
          {message}
        </div>
      )}
      <div className="attachment-list">
        {state.data?.attachments.map((row) => (
          <div key={String(row.id)}>
            <span>
              <Icon name="file" size={16} stroke={1.5} />
            </span>
            <div>
              <strong>{String(row.filename)}</strong>
              <small>
                {String(row.content_type)} · {formatBytes(Number(row.size))}
              </small>
            </div>
            <button
              className="text-danger"
              onClick={() => remove(String(row.id))}
            >
              Delete
            </button>
          </div>
        ))}
        {!state.data?.attachments.length && (
          <Empty
            title="No attachments"
            text="Upload files here, then select them in a campaign or ad hoc send."
          />
        )}
      </div>
    </Card>
  );
}

function Adhoc() {
  const templates = useData<{ templates: Row[] }>("/templates");
  const attachments = useData<{ attachments: Row[] }>("/attachments");
  const [form, setForm] = useState({
    to: "",
    from: "",
    fromName: "",
    templateName: "",
    subject: "",
    text: "",
    html: "",
    data: "{}",
  });
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = JSON.parse(form.data);
      const result = await api<{ requestId: string }>("/send-email", {
        method: "POST",
        ...jsonBody({
          ...form,
          templateName: form.templateName || undefined,
          data,
          attachmentIds: selected,
        }),
      });
      setMessage(`Accepted for delivery · ${result.requestId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        kicker="Delivery"
        title="Test email"
        text="Send a test message to a verified member of your account."
      />
      <form onSubmit={submit}>
        <Card title="Message">
          <div className="form-grid">
            <Field label="To">
              <input
                required
                type="email"
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            </Field>
            <Field label="From">
              <input
                required
                type="email"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </Field>
            <Field label="From name">
              <input
                value={form.fromName}
                onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              />
            </Field>
            <Field label="Template">
              <select
                value={form.templateName}
                onChange={(e) =>
                  setForm({ ...form, templateName: e.target.value })
                }
              >
                <option value="">Custom content</option>
                {templates.data?.templates.map((r) => (
                  <option key={String(r.name)}>{String(r.name)}</option>
                ))}
              </select>
            </Field>
            {!form.templateName && (
              <>
                <Field label="Subject">
                  <input
                    required
                    value={form.subject}
                    onChange={(e) =>
                      setForm({ ...form, subject: e.target.value })
                    }
                  />
                </Field>
                <Field label="Plain text">
                  <textarea
                    value={form.text}
                    onChange={(e) => setForm({ ...form, text: e.target.value })}
                  />
                </Field>
                <Field label="HTML">
                  <textarea
                    value={form.html}
                    onChange={(e) => setForm({ ...form, html: e.target.value })}
                  />
                </Field>
              </>
            )}
            <Field label="Template data" hint="JSON">
              <textarea
                value={form.data}
                onChange={(e) => setForm({ ...form, data: e.target.value })}
              />
            </Field>
          </div>
          <AttachmentPicker
            rows={attachments.data?.attachments ?? []}
            selected={selected}
            setSelected={setSelected}
          />
          {message && (
            <div
              className={
                message.startsWith("Accepted") ? "notice" : "form-error"
              }
            >
              {message}
            </div>
          )}
          <div className="form-actions">
            <button className="primary" disabled={busy}>
              {busy ? "Sending…" : "Send test email"}
            </button>
          </div>
        </Card>
      </form>
    </>
  );
}

function AttachmentPicker({
  rows,
  selected,
  setSelected,
}: {
  rows: Row[];
  selected: string[];
  setSelected: (ids: string[]) => void;
}) {
  if (!rows.length) return null;
  return (
    <Field label="Attachments" hint="Test messages only">
      <div className="chips">
        {rows.map((row) => {
          const item = String(row.id),
            active = selected.includes(item);
          return (
            <button
              type="button"
              className={active ? "selected" : ""}
              key={item}
              onClick={() =>
                setSelected(
                  active
                    ? selected.filter((id) => id !== item)
                    : [...selected, item],
                )
              }
            >
              {active ? "✓ " : "+ "}
              {String(row.filename)}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  text,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  text: string;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span />
      <div>
        <strong>{title}</strong>
        <small>{text}</small>
      </div>
    </label>
  );
}
