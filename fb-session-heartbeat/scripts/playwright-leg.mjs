// FB-SESSION HEARTBEAT -- Playwright leg.
// The Playwright MCP browser keeps its session in a persistent Chrome profile
// (~/Library/Caches/ms-playwright-mcp/mcp-chrome-*). That profile is usually
// LOCKED by the running MCP Chrome, and the MCP Chrome exposes only a CDP pipe
// (no TCP port), so we cannot attach. Instead: APFS-clone the profile
// (cp -Rc, copy-on-write, instant), strip the Singleton lock files, and launch
// a private headless Chrome (channel: "chrome" -- the SAME binary that owns the
// profile, so Keychain cookie decryption works) against the clone for a
// read-only authenticated probe of https://www.facebook.com/me.
//
// --fresh runs the identical probe in a brand-new EMPTY profile (no cookies):
// the mandatory negative test proving the signal discriminates.
//
// Prints exactly one line starting with RESULT: followed by JSON:
//   { u: finalUrl, t: title, a: ACCOUNT_ID-or-"absent", x: text snippet }
// Never reads or prints cookie/credential values. Never logs in.
import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire("/Users/blackceomacmini/clawd/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const url = get("--url") || "https://www.facebook.com/me";
const srcProfile = get("--profile");
const fresh = args.includes("--fresh");

// Absolute safety net: this process may never outlive its budget.
setTimeout(() => {
  console.error("hard timeout");
  process.exit(3);
}, 120000).unref();

const work = fs.mkdtempSync(
  path.join("/Users/blackceomacmini/clawd/fb-session-heartbeat/state", "pwclone-")
);
fs.chmodSync(work, 0o700);
const clone = path.join(work, "profile");

let ctx;
try {
  if (fresh) {
    fs.mkdirSync(clone, { recursive: true });
  } else {
    if (!srcProfile || !fs.existsSync(srcProfile)) {
      console.log("RESULT:" + JSON.stringify({ error: "profile missing: " + srcProfile }));
      process.exit(2);
    }
    // APFS copy-on-write clone; falls back to plain copy off-APFS.
    try {
      execFileSync("cp", ["-Rc", srcProfile, clone], { timeout: 30000 });
    } catch {
      execFileSync("cp", ["-R", srcProfile, clone], { timeout: 60000 });
    }
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort", "RunningChromeVersion"]) {
      try { fs.rmSync(path.join(clone, f), { force: true }); } catch {}
    }
  }

  ctx = await chromium.launchPersistentContext(clone, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1366, height: 900 },
    timeout: 60000,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000);
  const probe = await page.evaluate(() => ({
    u: location.href,
    t: document.title,
    a: (document.documentElement.innerHTML.match(/"ACCOUNT_ID":"(\d+)"/) || [])[1] || "absent",
    x: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 300),
  }));
  console.log("RESULT:" + JSON.stringify(probe));
} catch (e) {
  console.log("RESULT:" + JSON.stringify({ error: String(e).slice(0, 300) }));
  process.exitCode = 2;
} finally {
  try { if (ctx) await ctx.close(); } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode || 0);
