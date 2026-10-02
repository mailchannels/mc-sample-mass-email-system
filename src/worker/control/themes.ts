import type { Env } from "../types";
import { HttpError, json, readJson } from "../utils";
import { audit } from "./identity";
import { authorize, type Principal } from "./rbac";
export interface Theme {
  productName: string;
  primary: string;
  background: string;
  text: string;
  font: string;
  radius: string;
  supportLink: string;
}
// Matches the base stylesheet, so a partially customised theme stays consistent with it.
export const defaultTheme: Theme = {
  productName: "Email Studio",
  primary: "#35a047",
  background: "#ffffff",
  text: "#070a30",
  font: "Roboto",
  radius: "8px",
  supportLink: "",
};
export function validateTheme(value: Partial<Theme>): Theme {
  const theme = { ...defaultTheme, ...value };
  if (
    typeof theme.productName !== "string" ||
    theme.productName.length > 80 ||
    !theme.productName.trim()
  )
    throw new HttpError(400, "Product name must be 1–80 characters");
  for (const field of ["primary", "background", "text"] as const)
    if (!/^#[\da-f]{6}$/i.test(theme[field]))
      throw new HttpError(400, "Use six-digit hex colors");
  if (
    ![
      "Roboto",
      "system-ui",
      "Arial",
      "Georgia",
      "Verdana",
      "monospace",
    ].includes(theme.font)
  )
    throw new HttpError(400, "Unsupported font");
  if (!/^(?:[0-9]|[12][0-9]|30)px$/.test(theme.radius))
    throw new HttpError(400, "Radius must be 0–30px");
  if (theme.supportLink) {
    const url = new URL(theme.supportLink);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new HttpError(400, "Support link must use HTTPS");
  }
  return theme;
}
export function sanitizeCss(css: string): string {
  if (new TextEncoder().encode(css).length > 16_384)
    throw new HttpError(413, "Stylesheet limit is 16 KiB");
  // Conservative grammar: disallow escapes, comments, at-rules and all resource references.
  if (
    /[@\\<>]|\/\*|url\s*\(|expression\s*\(|image-set\s*\(|-moz-binding|behavior\s*:/i.test(
      css,
    )
  )
    throw new HttpError(400, "Stylesheet contains unsupported syntax");
  if (/[^\w\s.#,:;{}()%'"=+\-*/\[\]]/.test(css))
    throw new HttpError(400, "Stylesheet contains unsupported characters");
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  if (
    blocks
      .map((x) => x[0])
      .join("")
      .replace(/\s/g, "") !== css.replace(/\s/g, "")
  )
    throw new HttpError(400, "Invalid stylesheet");
  const properties = new Set([
    "color",
    "background-color",
    "border-color",
    "border-radius",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "padding",
    "margin",
    "box-shadow",
  ]);
  for (const [, selectors, declarations] of blocks) {
    if (
      selectors.includes("[") ||
      selectors.includes(":") ||
      !/^[\w\s.#,>+-]+$/.test(selectors)
    )
      throw new HttpError(400, "Use simple CSS selectors");
    for (const declaration of declarations
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)) {
      const [name, ...rest] = declaration.split(":");
      if (!properties.has(name.trim()) || !rest.join(":").trim())
        throw new HttpError(400, "Unsupported style property");
    }
  }
  return css;
}
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export async function themeFor(
  env: Env,
  resellerId: string | null,
): Promise<{
  theme: Theme;
  css: string;
  logo: boolean;
  favicon: boolean;
  custom: boolean;
}> {
  if (!resellerId)
    return {
      theme: { ...defaultTheme, productName: "Platform Console" },
      css: "",
      logo: false,
      favicon: false,
      custom: false,
    };
  const row = await env.DB.prepare("SELECT * FROM themes WHERE reseller_id=?1")
    .bind(resellerId)
    .first<{
      tokens_json: string;
      css_object_key: string | null;
      logo_object_key: string | null;
      favicon_object_key: string | null;
    }>();
  const css = row?.css_object_key
    ? ((await (await env.CONTENT.get(row.css_object_key))?.text()) ?? "")
    : "";
  return {
    theme: row ? validateTheme(JSON.parse(row.tokens_json)) : defaultTheme,
    css,
    logo: Boolean(row?.logo_object_key),
    favicon: Boolean(row?.favicon_object_key),
    custom: Boolean(row),
  };
}
export async function themed(
  response: Response,
  env: Env,
  resellerId: string | null,
): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("text/html"))
    return response;
  const { theme, css, logo, favicon, custom } = await themeFor(env, resellerId);
  let html = await response.text();
  const metadata = escape(
    JSON.stringify({ ...theme, logo: logo ? "/brand/logo" : null, custom }),
  );
  // Only a saved reseller theme overrides the base stylesheet; the platform console
  // and unbranded resellers render with the base design untouched. A saved theme maps
  // onto the base design tokens in both light and dark mode (branded sites hide the
  // theme toggle). The default Roboto keeps the base Montserrat headings.
  const font = `"${theme.font}",system-ui,sans-serif`;
  const fonts =
    theme.font === "Roboto"
      ? ""
      : `--font-body:${font};--font-heading:${font};`;
  const styles = !custom
    ? ""
    : `:root,:root.dark{--mc-green:${theme.primary};--accent:${theme.primary};--link:${theme.primary};--mc-teal:${theme.primary};--accent-ring:color-mix(in srgb,${theme.primary} 45%,transparent);--accent-soft:color-mix(in srgb,${theme.primary} 12%,transparent);--bg:${theme.background};--surface-raised:${theme.background};--surface:color-mix(in srgb,${theme.text} 4%,${theme.background});--border:color-mix(in srgb,${theme.text} 18%,${theme.background});--text:${theme.text};--text-muted:color-mix(in srgb,${theme.text} 75%,${theme.background});--text-faint:color-mix(in srgb,${theme.text} 55%,${theme.background});--cta-bg:${theme.text};--cta-fg:${theme.background};${fonts}--radius:${theme.radius};color-scheme:light}${css}`;
  html = html
    .replace(
      /<title>[^<]*<\/title>/,
      "<title>" + escape(theme.productName) + "</title>",
    )
    .replace(
      "</head>",
      `<meta name="product-theme" content="${metadata}">${styles ? `<style>${styles}</style>` : ""}${favicon ? '<link rel="icon" href="/brand/favicon">' : ""}</head>`,
    );
  return new Response(html, {
    status: response.status,
    headers: response.headers,
  });
}
export async function brandAsset(
  request: Request,
  env: Env,
  resellerId: string | null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!["/brand/logo", "/brand/favicon"].includes(path)) return null;
  if (!resellerId || request.method !== "GET")
    throw new HttpError(404, "Asset not found");
  const column = path.endsWith("logo")
    ? "logo_object_key"
    : "favicon_object_key";
  const row = await env.DB.prepare(
    `SELECT ${column} AS key FROM themes WHERE reseller_id=?1`,
  )
    .bind(resellerId)
    .first<{ key: string }>();
  const object = row?.key ? await env.CONTENT.get(row.key) : null;
  if (!object) throw new HttpError(404, "Asset not found");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      "cache-control": "private, max-age=300",
    },
  });
}
export async function themeRoutes(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/reseller/theme")) return null;
  authorize(p, "branding.write", "reseller", p.resellerId ?? "");
  const resellerId = p.resellerId!;
  if (path === "/api/reseller/theme" && request.method === "GET")
    return json(await themeFor(env, resellerId));
  if (path === "/api/reseller/theme" && request.method === "PUT") {
    const body = await readJson<{ tokens: Partial<Theme>; css?: string }>(
      request,
    );
    const tokens = validateTheme(body.tokens);
    const css = sanitizeCss(body.css ?? "");
    const key = `reseller/${resellerId}/theme.css`;
    await env.CONTENT.put(key, css, {
      httpMetadata: { contentType: "text/css" },
    });
    await env.DB.prepare(
      "INSERT INTO themes(reseller_id,tokens_json,css_object_key) VALUES (?1,?2,?3) ON CONFLICT(reseller_id) DO UPDATE SET tokens_json=excluded.tokens_json,css_object_key=excluded.css_object_key,version=version+1",
    )
      .bind(resellerId, JSON.stringify(tokens), key)
      .run();
    await audit(env, p, "theme.update", resellerId);
    return json({ ok: true });
  }
  if (
    ["/api/reseller/theme/logo", "/api/reseller/theme/favicon"].includes(
      path,
    ) &&
    request.method === "PUT"
  ) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > 512_000)
      throw new HttpError(413, "Image limit is 500 KiB");
    const png =
      bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new HttpError(400, "Upload a PNG or JPEG image");
    const kind = path.endsWith("logo") ? "logo" : "favicon";
    const key = `reseller/${resellerId}/${kind}`;
    await env.CONTENT.put(key, bytes, {
      httpMetadata: { contentType: png ? "image/png" : "image/jpeg" },
    });
    await env.DB.prepare(
      `INSERT INTO themes(reseller_id,${kind}_object_key) VALUES (?1,?2) ON CONFLICT(reseller_id) DO UPDATE SET ${kind}_object_key=excluded.${kind}_object_key,version=version+1`,
    )
      .bind(resellerId, key)
      .run();
    await audit(env, p, "theme.asset", kind);
    return json({ ok: true });
  }
  throw new HttpError(404, "Route not found");
}
