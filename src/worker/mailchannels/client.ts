import type { Env } from "../types";
import { HttpError } from "../utils";
export class ProviderError extends HttpError {
  constructor(public providerStatus: number) {
    super(502, `Email provider request failed (${providerStatus})`);
  }
}
export class MailChannels {
  constructor(
    private env: Env,
    private key: string,
  ) {}
  async call<T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const url = "https://api.mailchannels.net/tx/v1" + path;
    const init = {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { "x-api-key": this.key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response =
      this.env.LOCAL_TEST === "true" && this.env.PROVIDER
        ? await this.env.PROVIDER.fetch(url, init)
        : await fetch(url, init);
    if (!response.ok) throw new ProviderError(response.status);
    const text = await response.text();
    return {
      status: response.status,
      data: (text ? JSON.parse(text) : {}) as T,
    };
  }
  listAccounts() {
    return this.call("/sub-account");
  }
  createAccount(handle: string, name: string) {
    return this.call("/sub-account", "POST", { handle, company_name: name });
  }
  getAccount(handle: string) {
    return this.call("/sub-account/" + encodeURIComponent(handle));
  }
  createKey(handle: string) {
    return this.call<{ id: number; key: string }>(
      `/sub-account/${encodeURIComponent(handle)}/api-key`,
      "POST",
    );
  }
  deleteKey(handle: string, keyId: number) {
    return this.call(
      `/sub-account/${encodeURIComponent(handle)}/api-key/${keyId}`,
      "DELETE",
    );
  }
  limit(handle: string, sends: number) {
    return this.call(
      `/sub-account/${encodeURIComponent(handle)}/limit`,
      "PUT",
      { sends },
    );
  }
  suspend(handle: string) {
    return this.call(
      `/sub-account/${encodeURIComponent(handle)}/suspend`,
      "POST",
    );
  }
  activate(handle: string) {
    return this.call(
      `/sub-account/${encodeURIComponent(handle)}/activate`,
      "POST",
    );
  }
  deleteAccount(handle: string) {
    return this.call(`/sub-account/${encodeURIComponent(handle)}`, "DELETE");
  }
  webhook(url: string) {
    return this.call("/webhook", "POST", { webhook: url });
  }
  suppress(recipient: string) {
    return this.call("/suppression-list", "POST", {
      suppression_entries: [
        { recipient, suppression_types: ["non-transactional"] },
      ],
    });
  }
  dkim(domain: string, selector: string) {
    return this.call<{ selector: string; dkim_dns_records: unknown[] }>(
      `/domains/${encodeURIComponent(domain)}/dkim-keys`,
      "POST",
      { selector, key_length: 2048 },
    );
  }
  checkDomain(domain: string) {
    return this.call<{
      check_results: {
        domain_lockdown?: { verdict: string };
        spf?: { verdict: string };
        dkim?: { verdict: string }[];
      };
    }>("/check-domain", "POST", { domain });
  }
  tracking(hostname: string, scope: string, name: string) {
    return this.call<{ token?: string; status?: string }>(
      "/custom-tracking-domains",
      "POST",
      { hostname, scope, name },
    );
  }
  usage() {
    return this.call<{
      total_usage: number;
      monthly_limit: number;
      period_start_date: string;
      period_end_date: string;
    }>("/usage");
  }
}
