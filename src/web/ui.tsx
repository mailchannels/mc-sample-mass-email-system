import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";

export type Row = Record<string, unknown>;

export interface Me {
  email: string;
  scopeType: string;
  scopeId: string;
  roles: { scope_type: string; scope_id: string; role: string }[];
  impersonating: boolean;
  reason?: string;
}

export const SessionContext = createContext<Me | undefined>(undefined);

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  badge?: string;
}

export function productTheme(): {
  productName?: string;
  logo?: string;
  supportLink?: string;
  custom?: boolean;
} {
  try {
    return JSON.parse(
      document
        .querySelector('meta[name="product-theme"]')
        ?.getAttribute("content") ?? "{}",
    );
  } catch {
    return {};
  }
}

export function signOut() {
  api("/auth/logout", { method: "POST" }).then(() => location.assign("/"));
}

/* ---------- Icons: stroked, 24px viewBox, lucide style ---------- */

const paths = {
  overview: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  plus: ["M12 5v14", "M5 12h14"],
  file: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    "M14 2v6h6",
    "M16 13H8",
    "M16 17H8",
    "M10 9H8",
  ],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"],
  sliders: [
    "M4 21v-7",
    "M4 10V3",
    "M12 21v-9",
    "M12 8V3",
    "M20 21v-5",
    "M20 12V3",
    "M1 14h6",
    "M9 8h6",
    "M17 16h6",
  ],
  building: [
    "M3 21h18",
    "M5 21V7l8-4v18",
    "M19 21V11l-6-4",
    "M9 9v.01",
    "M9 12v.01",
    "M9 15v.01",
    "M9 18v.01",
  ],
  briefcase: [
    "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z",
    "M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  ],
  layers: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  chart: ["M3 3v18h18", "M18 17V9", "M13 17V5", "M8 17v-3"],
  pulse: [
    "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
    "M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27",
  ],
  warn: [
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
    "M12 9v4",
    "M12 17h.01",
  ],
  globe: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  ],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  palette: [
    "M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-1.5a1.5 1.5 0 0 0-1.1 2.5 1.5 1.5 0 0 1-1.1 2.5Z",
    "M13.5 6.5h.01",
    "M17.5 10.5h.01",
    "M8.5 7.5h.01",
    "M6.5 12.5h.01",
  ],
  plug: [
    "M12 22v-5",
    "M9 8V2",
    "M15 8V2",
    "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z",
  ],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
  upload: [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "m17 8-5-5-5 5",
    "M12 3v12",
  ],
  download: [
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    "m7 10 5 5 5-5",
    "M12 15V3",
  ],
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  check: ["M20 6 9 17l-5-5"],
  mail: [
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "m22 6-10 7L2 6",
  ],
  inbox: [
    "M22 12h-6l-2 3h-4l-2-3H2",
    "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  ],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"],
  sun: [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  ],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"],
  monitor: [
    "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M8 21h8M12 17v4",
  ],
  logout: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "m16 17 5-5-5-5",
    "M21 12H9",
  ],
};
export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 15,
  stroke = 1.75,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/* ---------- Shell: sticky brand row, tab row, page column, footer ---------- */

const THEMES = ["auto", "light", "dark"] as const;
type ThemeChoice = (typeof THEMES)[number];
const THEME_TITLE: Record<ThemeChoice, string> = {
  auto: "Theme follows the system. Switch to light",
  light: "Light theme. Switch to dark",
  dark: "Dark theme. Follow the system",
};

/** Cycles auto, light, dark; the choice persists as "mc-theme" and
 *  /theme-bootstrap.js applies it before first paint. */
function ThemeButton() {
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    try {
      const stored = localStorage.getItem("mc-theme") as ThemeChoice | null;
      return stored && THEMES.includes(stored) ? stored : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const root = document.documentElement,
      query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "auto" && query.matches);
      root.classList.toggle("dark", dark);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    try {
      localStorage.setItem("mc-theme", theme);
    } catch {
      // Storage may be unavailable.
    }
    return () => query.removeEventListener("change", apply);
  }, [theme]);
  return (
    <button
      type="button"
      className="pill icon"
      onClick={() =>
        setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])
      }
      title={THEME_TITLE[theme]}
      aria-label={THEME_TITLE[theme]}
    >
      <Icon
        name={theme === "auto" ? "monitor" : theme === "light" ? "sun" : "moon"}
      />
    </button>
  );
}

export function Shell({
  name,
  tagline,
  nav,
  active,
  href,
  links,
  scope,
  mailchannels = false,
  footer,
  children,
}: {
  name: string;
  tagline: string;
  nav: readonly NavItem[];
  active: string;
  href: (key: string) => string;
  links?: ReactNode;
  scope?: "platform" | "reseller";
  /** The operator console carries the MailChannels mark; white-label sites never do. */
  mailchannels?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const me = useContext(SessionContext);
  const theme = productTheme();
  const email = me?.email ?? "Signed in";
  // Operator consoles show the console's role; the customer workspace shows the account role.
  const assignment = me?.roles.find((r) =>
    scope
      ? r.scope_type === scope
      : r.scope_type === me.scopeType && r.scope_id === me.scopeId,
  );
  return (
    <div className="app-shell">
      <a className="skip" href="#main-content">
        Skip to content
      </a>
      <header className="navbar">
        <div className="navbar-row">
          <a className="brand" href={href(nav[0].key)}>
            {mailchannels ? (
              <>
                <span className="logo" role="img" aria-label="MailChannels" />
                <span className="brand-div" />
              </>
            ) : theme.logo ? (
              <>
                <img className="brand-image" src={theme.logo} alt="" />
                <span className="brand-div" />
              </>
            ) : (
              <span className="brand-mark" aria-hidden="true">
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="brand-name">
              <strong>{name}</strong>
              <small>{tagline}</small>
            </span>
          </a>
          <div className="nav-actions">
            {links}
            {!theme.custom && <ThemeButton />}
            <span className="operator">
              <span className="avatar">{initials(email)}</span>
              <span>
                <strong>{email}</strong>
                <small>
                  {assignment
                    ? `${capitalize(assignment.role)} · ${assignment.scope_id}`
                    : "Signed in"}
                </small>
              </span>
            </span>
            {me && !me.impersonating && (
              <button
                type="button"
                className="pill icon"
                onClick={signOut}
                title="Sign out"
                aria-label="Sign out"
              >
                <Icon name="logout" />
              </button>
            )}
          </div>
        </div>
        <nav className="nav-tabs" aria-label="Sections">
          {nav.map(({ key, label, icon, badge }) => (
            <a
              key={key}
              href={href(key)}
              className={active === key ? "active" : ""}
              aria-current={active === key ? "page" : undefined}
            >
              <Icon name={icon} />
              {label}
              {badge && <span className="nav-badge">{badge}</span>}
            </a>
          ))}
        </nav>
      </header>
      <main id="main-content" tabIndex={-1}>
        <div className="page">{children}</div>
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span>{name}</span>
          <span className="footer-links">
            {footer}
            {theme.supportLink && (
              <a href={theme.supportLink}>Help & support</a>
            )}
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Building blocks ---------- */

export function PageHeading({
  kicker,
  title,
  text,
  action,
}: {
  kicker: string;
  title: string;
  text: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action && <div className="page-heading-action">{action}</div>}
    </div>
  );
}

export function BackLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="back" onClick={onClick}>
      <Icon name="back" />
      {label}
    </button>
  );
}

export function Card({
  title,
  action,
  className = "",
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header>
          <h2>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

// One lookup from raw enum values to a tone; unknown values stay neutral.
const tones: Record<string, "good" | "active" | "warn" | "bad"> = {
  active: "good",
  completed: "good",
  complete: "good",
  delivered: "good",
  ready: "good",
  accepted: "good",
  verified: "good",
  done: "good",
  sent: "good",
  opened: "good",
  clicked: "good",
  replayed: "good",
  running: "active",
  processing: "active",
  processed: "active",
  provisioning: "active",
  pending: "active",
  sending: "active",
  scheduled: "active",
  create: "active",
  key: "active",
  webhook: "active",
  limit: "active",
  paused: "warn",
  "completed-with-errors": "warn",
  retry: "warn",
  failed: "bad",
  bounced: "bad",
  dropped: "bad",
  complained: "bad",
  suspended: "bad",
  revoked: "bad",
  deleting: "bad",
};

export function Status({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return (
    <span className={`status ${tones[normalized] ?? ""}`}>
      <i />
      {capitalize(value.toLowerCase().replaceAll("_", " "))}
    </span>
  );
}

export function Empty({
  title,
  text,
  icon = "inbox",
}: {
  title: string;
  text: string;
  icon?: IconName;
}) {
  return (
    <div className="empty">
      <span>
        <Icon name={icon} size={18} stroke={1.5} />
      </span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export function Loading({ small = false }: { small?: boolean }) {
  return (
    <div
      className={`loading ${small ? "small" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span />
      <span />
      <span />
      <p>Loading</p>
    </div>
  );
}

export function ErrorBox({
  error,
  retry,
}: {
  error?: string;
  retry: () => void;
}) {
  return (
    <div className="error-box">
      <strong>Could not load this view</strong>
      <p>{error}</p>
      <button className="secondary" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function Metric({
  label,
  value,
  note,
  color = "green",
}: {
  label: string;
  value: number;
  note: string;
  color?: "green" | "blue" | "lime" | "aqua" | "warn";
}) {
  return (
    <article className={`metric ${color}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
      <small>{note}</small>
    </article>
  );
}

export function useData<T>(path: string, interval?: number) {
  const [data, setData] = useState<T>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    // An empty path means "nothing to fetch" (e.g. a view not available in this scope).
    if (!path) {
      setLoading(false);
      return;
    }
    try {
      setError(undefined);
      const value = await api<T>(path);
      setData(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    reload();
    if (!interval) return;
    const timer = setInterval(reload, interval);
    return () => clearInterval(timer);
  }, [reload, interval]);
  return { data, loading, error, reload };
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1000000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value || 0);
}
export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
export function formatDate(value: unknown) {
  if (!value) return "—";
  // D1 timestamps are UTC without a zone ("2026-10-02 19:13:41"); epoch values are milliseconds.
  const date =
    typeof value === "number"
      ? new Date(value)
      : new Date(
          String(value).replace(
            /^(\d{4}-\d\d-\d\d) (\d\d:\d\d(:\d\d)?)$/,
            "$1T$2Z",
          ),
        );
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
export function initials(value: string) {
  return (
    value
      .split("@")[0]
      .split(/[._ -]/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "OP"
  );
}
export function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
