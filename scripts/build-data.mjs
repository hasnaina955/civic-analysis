// Build the state effectiveness index from raw RBI Handbook XLSX tables.
// Output: data/states.json + embedded JSON block in index.html between markers.
//
// Metrics (all from RBI Handbook of Statistics on Indian States, 2024-25 edition):
//   fiscal actuals (Tables 164/166/168/173 + GSDP Table 21)  -> FY2021-22 (latest actuals)
//   per-capita income (Table 19)                             -> 2024-25, growth from 2017-18
//
// Score: robust z = (x - median) / IQR per metric (sign-flipped where lower is
// better), weighted sum, then rescaled so the cohort median = 50 and the range
// maps to 10..90. Documented identically in index.html's methodology section.
import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');

const FISCAL_YEAR = '2021-22'; // latest actuals available in fiscal tables
const INCOME_YEAR = '2024-25';
const INCOME_BASE = '2017-18';
const INCOME_BASE_N = 7; // years between base and current

// The 28 states (UTs and aggregate rows excluded from scoring).
const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

// metric -> [sign, weight]; sign -1 means lower is better.
const WEIGHTS = {
  fdPct: [-1, 0.25],
  capexPct: [+1, 0.25],
  taxPct: [+1, 0.20],
  revSelf: [+1, 0.15],
  pcNsdp: [+1, 0.10],
  incomeCagr: [+1, 0.05],
};

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.replace(/,/g, '').trim();
    if (/^-|\(.*\)$/.test(t)) {
      const m = t.match(/\((.*)\)/);
      if (m) return -parseFloat(m[1]);
      return parseFloat(t);
    }
    const f = parseFloat(t);
    return isFinite(f) ? f : null;
  }
  return null;
}

// Read sheet index `si` of a workbook into Map<state, Map<year, number>>.
// Values are scaled so money tables are in ₹ crore (the sheet declares its
// unit on row 1, e.g. "(₹ Lakh)" or "(₹ Crore)"; per-capita tables are plain ₹).
function readTable(file, si = 1) {
  const wb = XLSX.readFile(path.join(RAW, file));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[si]], { header: 1, raw: true });
  const unitRow = rows.find((r) => Array.isArray(r) && typeof r[0] === 'string' && /^\(₹/.test(r[0]));
  const unit = unitRow ? unitRow[0] : '';
  const scale = /Lakh/i.test(unit) ? 1 / 100 : 1; // ₹ lakh → ₹ crore
  let headerRow = -1;
  let years = [];
  for (let i = 0; i < rows.length; i++) {
    const ys = (rows[i] || []).filter((c) => typeof c === 'string' && /^\d{4}-\d{2}$/.test(c));
    if (ys.length >= 3) { headerRow = i; years = rows[i]; break; }
  }
  if (headerRow < 0) throw new Error(`${file}: no year header row`);
  const out = new Map();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = r[0];
    if (typeof name !== 'string') continue;
    const state = name.replace(/\*$/, '').trim();
    if (!STATES.includes(state)) continue;
    const byYear = new Map();
    years.forEach((y, ci) => {
      if (typeof y === 'string' && /^\d{4}-\d{2}$/.test(y)) {
        const v = num(r[ci]);
        byYear.set(y, v == null ? null : v * scale);
      }
    });
    out.set(state, byYear);
  }
  return out;
}

const fiscal = {
  fd: readTable('164_fiscal_deficit.XLSX'),
  rev: readTable('166_revenue_expenditure.XLSX'),
  tax: readTable('168_own_tax.XLSX'),
  capex: readTable('173_capital_expenditure.XLSX'),
  gsdp: readTable('21_gsdp.XLSX'),
  pc: readTable('19_per_capita_nsdp.XLSX'),
};

const missing = [];
function val(tbl, state, year) {
  const v = tbl.get(state)?.get(year);
  if (v == null || !isFinite(v)) { missing.push(`${state} ${year}`); return null; }
  return v;
}

const states = [];
for (const state of STATES) {
  const fd = val(fiscal.fd, state, FISCAL_YEAR);
  const rev = val(fiscal.rev, state, FISCAL_YEAR);
  const tax = val(fiscal.tax, state, FISCAL_YEAR);
  const capex = val(fiscal.capex, state, FISCAL_YEAR);
  const gsdp = val(fiscal.gsdp, state, FISCAL_YEAR);
  const pcNow = val(fiscal.pc, state, INCOME_YEAR);
  const pcBase = val(fiscal.pc, state, INCOME_BASE);

  const m = {
    fdPct: fd != null && gsdp ? (fd / gsdp) * 100 : null,
    capexPct: capex != null && gsdp ? (capex / gsdp) * 100 : null,
    taxPct: tax != null && gsdp ? (tax / gsdp) * 100 : null,
    revSelf: tax != null && rev ? (tax / rev) * 100 : null,
    pcNsdp: pcNow,
    incomeCagr: pcNow != null && pcBase ? (Math.pow(pcNow / pcBase, 1 / INCOME_BASE_N) - 1) * 100 : null,
    gsdpCr: gsdp,
    fiscalYear: FISCAL_YEAR,
    incomeYear: INCOME_YEAR,
  };
  const have = Object.keys(WEIGHTS).filter((k) => m[k] != null);
  if (have.length < 4) { missing.push(`${state}: only ${have.length} metrics`); continue; }
  states.push({ state, metrics: m, _have: have });
}

// --- robust z per metric -------------------------------------------------
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const quartiles = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  const lo = s.slice(0, h), hi = s.slice(s.length - h);
  return [median(lo), median(hi)];
};

const zsums = [];
for (const [key, [sign, w]] of Object.entries(WEIGHTS)) {
  const vals = states.filter((s) => s.metrics[key] != null).map((s) => s.metrics[key]);
  const [q1, q3] = quartiles(vals);
  const iqr = q3 - q1 || 1;
  const med = median(vals);
  for (const s of states) {
    if (s.metrics[key] == null) continue;
    const z = ((s.metrics[key] - med) / iqr) * sign;
    s._z = s._z || {};
    s._z[key] = z;
    s._wz = (s._wz || 0) + z * w;
    s._wsum = (s._wsum || 0) + w;
  }
}
for (const s of states) s._wz /= s._wsum; // renormalize if metrics were missing

const wzList = states.map((s) => s._wz);
const medWz = median(wzList);
const maxDev = Math.max(...wzList.map((z) => Math.abs(z - medWz))) || 1;
for (const s of states) {
  s.score = Math.round((50 + (40 * (s._wz - medWz)) / maxDev) * 10) / 10;
}

states.sort((a, b) => b.score - a.score);
const payload = {
  meta: {
    source: 'Reserve Bank of India — Handbook of Statistics on Indian States, 2024-25 edition',
    sourceUrl: 'https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=Handbook%20of%20Statistics%20on%20Indian%20States',
    fiscalYear: FISCAL_YEAR,
    incomeYear: INCOME_YEAR,
    incomeBase: INCOME_BASE,
    generated: new Date().toISOString().slice(0, 10),
    nStates: states.length,
    weights: WEIGHTS,
  },
  states: states.map((s) => ({ state: s.state, score: s.score, metrics: s.metrics })),
};

const json = JSON.stringify(payload);
fs.writeFileSync(path.join(ROOT, 'data', 'states.json'), JSON.stringify(payload, null, 2));

// embed into index.html between markers (idempotent)
const htmlPath = path.join(ROOT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const START = '<!-- STATE_DATA_START -->';
const END = '<!-- STATE_DATA_END -->';
const block = `${START}\n<script id="state-data" type="application/json">${json}</script>\n${END}`;
const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < 0) { console.error('markers missing in index.html'); process.exit(1); }
html = html.slice(0, i) + block + html.slice(j + END.length);
fs.writeFileSync(htmlPath, html);

console.log(`built data/states.json and embedded ${payload.states.length} states`);
if (missing.length) console.log('missing:', missing.join('; '));
console.log('top 3:', payload.states.slice(0, 3).map((s) => `${s.state} ${s.score}`).join(' | '));
console.log('bottom 3:', payload.states.slice(-3).map((s) => `${s.state} ${s.score}`).join(' | '));
