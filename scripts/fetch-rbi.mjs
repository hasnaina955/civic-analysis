// Fetch RBI Handbook of Statistics on Indian States (2024-25 edition) XLSX tables.
// RBI's CDN drops rapid/parallel connections, so we go sequential with backoff.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'raw');
fs.mkdirSync(OUT, { recursive: true });

const TABLES = {
  // state finances (₹ crore unless noted)
  '164_fiscal_deficit.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/164T_1112202508BBFFBF092F406D8E7BE60C14A01DAE.XLSX',
  '166_revenue_expenditure.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/166T_11122025312B8C5D05BA435B980E3658F96541C4.XLSX',
  '168_own_tax.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/168T_111220256B7415AC1AB24E97B4EECEB4FB7055C0.XLSX',
  '173_capital_expenditure.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/173T_111220258D78C5BE1521455588EC9842ECC3D997.XLSX',
  // nsdp (₹ per capita, current prices)
  '19_per_capita_nsdp.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/19T_11122025B8CC230E4A34431999B4D6A107707BCA.XLSX',
  // gross state domestic product (₹ crore, current prices) — normalizer
  '21_gsdp.XLSX': 'https://rbidocs.rbi.org.in/rdocs/Publications/DOCs/21T_11122025D994949B48C44B68B4465FBB9ADDFF3D.XLSX',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: 'https://www.rbi.org.in/',
  Accept: '*/*',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => resolve());
      f.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(45_000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchWithRetry(name, url, tries = 5) {
  const dest = path.join(OUT, name);
  for (let i = 1; i <= tries; i++) {
    try {
      await fetchOnce(url, dest);
      const magic = fs.readFileSync(dest).subarray(0, 2).toString();
      if (magic !== 'PK') throw new Error('not a zip/xlsx (got HTML challenge page)');
      console.log(`ok  ${name} (${fs.statSync(dest).size} bytes)`);
      return true;
    } catch (e) {
      console.log(`..  ${name} attempt ${i}/${tries} failed: ${e.message}`);
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      if (i < tries) await sleep(2000 * i);
    }
  }
  return false;
}

let failures = 0;
for (const [name, url] of Object.entries(TABLES)) {
  if (fs.existsSync(path.join(OUT, name))) {
    const magic = fs.readFileSync(path.join(OUT, name)).subarray(0, 2).toString();
    if (magic === 'PK') { console.log(`skip ${name} (already present)`); continue; }
  }
  const ok = await fetchWithRetry(name, url);
  if (!ok) failures++;
  await sleep(1500); // be polite; the CDN hangs up on bursts
}
process.exit(failures ? 1 : 0);
