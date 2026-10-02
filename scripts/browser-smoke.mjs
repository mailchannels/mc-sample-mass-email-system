import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const port = Number(process.env.LOCAL_PORT ?? 8790);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
try {
  await page.goto(`http://a.localhost:${port}`);
  await page.getByRole("heading", { name: "Send at scale." }).waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /MailChannels|Cloudflare/,
  );
  await page.getByRole("link", { name: "Templates", exact: true }).click();
  await page.getByRole("button", { name: "New template +" }).click();
  const name = "browser-" + Date.now();
  await page.getByLabel("Template name").fill(name);
  await page.getByLabel("Subject", { exact: true }).fill("Browser smoke test");
  await page
    .getByLabel("Plain text", { exact: true })
    .fill("Hello {{firstName}}");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.goto(`http://b.localhost:${port}/#templates`);
  await page.getByRole("heading", { name: "Mustache templates" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name, exact: true }).count(),
    0,
  );
  await page.goto(`http://a.localhost:${port}/#reseller`);
  await page.getByRole("link", { name: "Branding", exact: true }).click();
  await page.getByLabel("Product name").fill("Pilot Post");
  await page.getByLabel("Font", { exact: true }).selectOption("system-ui");
  // Saving the theme reloads the page so the new brand applies immediately.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Save theme", exact: true }).click(),
  ]);
  assert.equal(await page.title(), "Pilot Post");
  await page.goto(`http://platform.localhost:${port}`);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  assert.equal(await page.title(), "Platform Console");
  await page.getByRole("link", { name: "Health", exact: true }).click();
  await page.getByRole("heading", { name: /^Alerts/ }).waitFor();
  await page.getByRole("heading", { name: /^Provisioning/ }).waitFor();
  await mkdir(".local", { recursive: true });
  await page.screenshot({ path: ".local/platform-smoke.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: template creation, tenant isolation, theme save/injection, and platform health console.",
  );
} finally {
  await browser.close();
}
