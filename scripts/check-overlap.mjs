#!/usr/bin/env node
// Regression guard for the score-bar bug: the right-aligned score value used to
// render on top of the saffron bar (tbody td is text-align:right while the bar
// was absolutely positioned across the cell). This script loads the page in a
// headless browser and fails (exit 1) if any leaderboard cell content overlaps
// a graphic behind it, or if the page's rows/structure are missing (so a
// vacuous pass is impossible).
//
//   node scripts/check-overlap.mjs [path/to/index.html]
//
// Uses a locally installed Chrome/Edge/Chromium; override with
// CHROME_PATH=<browser executable>. Exit codes:
//   0 — clean
//   1 — overlaps (or missing score-bar structure) found
//   2 — could not check (no browser, missing file, page failed, 0 rows)

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? path.join(ROOT, "index.html"));

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const exe = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error("check-overlap: no Chrome/Edge/Chromium found. Set CHROME_PATH=<browser executable>.");
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`check-overlap: no such file: ${target}`);
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

let outcome;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(target).href, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("#lbBody tr", { timeout: 10_000 });
  outcome = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const toRgb = (v) => {
      v = v.trim();
      if (/^#[0-9a-f]{6}$/i.test(v))
        return `rgb(${parseInt(v.slice(1, 3), 16)}, ${parseInt(v.slice(3, 5), 16)}, ${parseInt(v.slice(5, 7), 16)})`;
      if (/^#[0-9a-f]{3}$/i.test(v))
        return `rgb(${parseInt(v[1] + v[1], 16)}, ${parseInt(v[2] + v[2], 16)}, ${parseInt(v[3] + v[3], 16)})`;
      return v;
    };
    // page surfaces / ink are legitimate backgrounds behind text; anything
    // else (saffron bars, tint blocks, party dots…) must not sit under text
    // it does not contain.
    const neutral = new Set(["rgba(0, 0, 0, 0)", "transparent", "rgb(255, 255, 255)"]);
    for (const n of ["--paper", "--paper-2", "--card", "--rule", "--ink", "--ink-soft", "--ink-faint"]) {
      const v = rootStyle.getPropertyValue(n);
      if (v) neutral.add(toRgb(v));
    }
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.15;
    };
    const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const describe = (el) =>
      el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "");

    const problems = [];
    const rows = [...document.querySelectorAll("#lbBody tr")];

    // (1) score-bar: the value must never intersect its bar
    for (const tr of rows) {
      const bar = tr.querySelector(".score-bar .bar");
      const val = tr.querySelector(".score-bar .val");
      if (!bar || !val) {
        problems.push(`row missing .score-bar structure: "${tr.textContent.trim().slice(0, 48)}"`);
        continue;
      }
      const b = bar.getBoundingClientRect();
      const v = val.getBoundingClientRect();
      const ix = Math.min(v.right, b.right) - Math.max(v.left, b.left);
      const iy = Math.min(v.bottom, b.bottom) - Math.max(v.top, b.top);
      if (ix > 0.5 && iy > 0.5)
        problems.push(`score bar under value ${val.textContent.trim()} (${Math.round(ix)}x${Math.round(iy)}px overlap)`);
    }

    // (2) generic: no non-neutral background may sit under unrelated text
    const all = [...document.querySelectorAll("body *")];
    const texts = all.filter((el) => visible(el) && ownText(el));
    const graphics = all.filter((el) => {
      if (!visible(el) || ownText(el)) return false;
      const bg = getComputedStyle(el).backgroundColor;
      return bg && !neutral.has(bg);
    });
    for (const t of texts) {
      const tr = t.getBoundingClientRect();
      for (const g of graphics) {
        if (t === g || t.contains(g) || g.contains(t)) continue;
        const gr = g.getBoundingClientRect();
        const ix = Math.min(tr.right, gr.right) - Math.max(tr.left, gr.left);
        const iy = Math.min(tr.bottom, gr.bottom) - Math.max(tr.top, gr.top);
        if (ix > 2 && iy > 2)
          problems.push(
            `"${t.textContent.trim().slice(0, 30)}" (${describe(t)}) sits over ${describe(g)} (${getComputedStyle(g).backgroundColor})`
          );
      }
    }
    return { rows: rows.length, problems };
  });
} catch (err) {
  outcome = { error: err.message };
} finally {
  await browser.close();
}

if (outcome.error) {
  console.error(`check-overlap: could not check the page — ${outcome.error}`);
  process.exit(2);
}
if (outcome.rows === 0) {
  console.error("check-overlap: leaderboard rendered 0 rows — refusing a vacuous pass.");
  process.exit(2);
}
if (outcome.problems.length) {
  console.error(`check-overlap: FAILED — ${outcome.problems.length} problem(s) in ${outcome.rows} rows:`);
  for (const p of outcome.problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-overlap: OK — ${outcome.rows} leaderboard rows, no text/graphic overlaps.`);
