import { z } from 'zod';

// SEC EDGAR filings for the Tape: each listed company's recent filings, from the public submissions API
// (https://data.sec.gov/submissions/CIK##########.json), tagged so the ones that usually move a small cap stand out:
// offerings, shelf registrations, dilution, charter changes (reverse splits are filed this way), listing notices.
// EDGAR asks automated clients to send a descriptive User-Agent and to stay under 10 requests a second.

const recent = z.object({
  accessionNumber: z.array(z.string()),
  filingDate: z.array(z.string()),
  reportDate: z.array(z.string()).optional(),
  acceptanceDateTime: z.array(z.string()),
  form: z.array(z.string()),
  items: z.array(z.string()).optional(),
  primaryDocument: z.array(z.string()),
  primaryDocDescription: z.array(z.string()).optional(),
});
const submissions = z.looseObject({
  cik: z.union([z.string(), z.number()]),
  name: z.string(),
  tickers: z.array(z.string()).optional(),
  filings: z.object({ recent }),
});

export type FilingTag =
  | 'offering'
  | 'shelf'
  | 'dilution'
  | 'charter_change'
  | 'shareholder_vote'
  | 'listing_notice'
  | 'late_filing'
  | 'delisting'
  | 'financing'
  | 'earnings'
  | 'insider_sale'
  | 'insider_trade'
  | 'ownership'
  | 'report'
  | 'event';

export type FilingImportance = 'high' | 'medium' | 'low';

export interface Filing {
  accession: string;
  form: string;
  /** When EDGAR accepted the filing (ISO, UTC). */
  acceptedAt: string;
  filingDate: string;
  reportDate: string | null;
  /** 8-K item numbers, for example ["2.02", "9.01"]. */
  items: string[];
  description: string | null;
  url: string;
  tags: FilingTag[];
  importance: FilingImportance;
}

export interface CompanyFilings {
  cik: number;
  name: string;
  filings: Filing[];
}

/** Forms that register or sell new shares. */
const OFFERING = /^(S-1|F-1|S-11|424B[1-8]|FWP|S-1MEF|F-1MEF)(\/A)?$/;
const SHELF = /^(S-3|F-3|S-3ASR|F-3ASR|EFFECT|S-3MEF|F-3MEF)(\/A)?$/;
const REPORT = /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/;
const OWNERSHIP = /^(SC 13D|SC 13G|SCHEDULE 13D|SCHEDULE 13G)(\/A)?$/;

const ITEM_TAGS: Record<string, { tag: FilingTag; importance: FilingImportance }> = {
  '1.01': { tag: 'financing', importance: 'medium' }, // material agreement: often an offering, ATM or credit deal
  '2.02': { tag: 'earnings', importance: 'medium' },
  '2.03': { tag: 'financing', importance: 'medium' }, // new debt or obligation
  '3.01': { tag: 'listing_notice', importance: 'high' }, // notice of delisting or failure to meet a listing rule
  '3.02': { tag: 'dilution', importance: 'high' }, // unregistered sale of equity
  '3.03': { tag: 'charter_change', importance: 'medium' }, // material change to shareholders' rights
  '5.03': { tag: 'charter_change', importance: 'high' }, // articles or bylaws amended: reverse splits are filed here
  '5.07': { tag: 'shareholder_vote', importance: 'low' },
};

const RANK: Record<FilingImportance, number> = { low: 0, medium: 1, high: 2 };

/** Tags and importance for one filing, from its form type and (for an 8-K) its item numbers. */
export function classifyFiling(form: string, items: string[] = []): { tags: FilingTag[]; importance: FilingImportance } {
  const f = form.trim().toUpperCase();
  const tags = new Set<FilingTag>();
  let importance: FilingImportance = 'low';
  const add = (tag: FilingTag, level: FilingImportance) => {
    tags.add(tag);
    if (RANK[level] > RANK[importance]) importance = level;
  };

  if (OFFERING.test(f)) add('offering', 'high');
  else if (SHELF.test(f)) add('shelf', 'medium');
  else if (/^S-8(\/A| POS)?$/.test(f)) add('dilution', 'medium');
  else if (/^(PRE 14A|PRE 14C)$/.test(f)) add('shareholder_vote', 'medium'); // preliminary proxy: share increases and reverse splits are proposed here
  else if (/^(DEF 14A|DEF 14C|DEFA14A|DEFM14A)$/.test(f)) add('shareholder_vote', 'low');
  else if (/^NT (10-K|10-Q|20-F)(\/A)?$/.test(f)) add('late_filing', 'high');
  else if (/^25(-NSE)?(\/A)?$/.test(f) || /^15-12[BG]$/.test(f) || /^15F-12[BG]$/.test(f)) add('delisting', 'high');
  else if (f === '144' || f === '144/A') add('insider_sale', 'medium');
  else if (/^[345](\/A)?$/.test(f)) add('insider_trade', 'low');
  else if (OWNERSHIP.test(f)) add('ownership', /13D/.test(f) ? 'medium' : 'low');
  else if (REPORT.test(f)) add('report', 'low');

  // An 8-K (a 6-K for a foreign issuer) is a current report; its item numbers say what happened.
  if (/^[86]-K(\/A)?$/.test(f)) {
    for (const item of items) {
      const hit = ITEM_TAGS[item.trim()];
      if (hit) add(hit.tag, hit.importance);
    }
  }
  if (!tags.size) add('event', 'low');
  return { tags: [...tags], importance };
}

export const filingUrl = (cik: number, accession: string, primaryDocument: string): string =>
  `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${primaryDocument}`;

/**
 * Recent filings from one submissions document, newest first, accepted at or after `sinceMs`, at most `limit`.
 * Malformed rows (missing dates or forms) are skipped rather than guessed.
 */
export function parseSubmissions(json: unknown, opts: { sinceMs: number; limit: number }): CompanyFilings {
  const doc = submissions.parse(json);
  const cik = Number(doc.cik);
  const r = doc.filings.recent;
  const out: Filing[] = [];
  for (let i = 0; i < r.accessionNumber.length && out.length < opts.limit; i++) {
    const form = r.form[i];
    const accession = r.accessionNumber[i];
    const accepted = r.acceptanceDateTime[i];
    const primary = r.primaryDocument[i];
    if (!form || !accession || !accepted || !primary) continue;
    const acceptedMs = Date.parse(accepted);
    if (!Number.isFinite(acceptedMs)) continue;
    if (acceptedMs < opts.sinceMs) continue;
    const items = (r.items?.[i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const { tags, importance } = classifyFiling(form, items);
    out.push({
      accession,
      form,
      acceptedAt: new Date(acceptedMs).toISOString(),
      filingDate: r.filingDate[i] ?? accepted.slice(0, 10),
      reportDate: r.reportDate?.[i] || null,
      items,
      description: r.primaryDocDescription?.[i] || null,
      url: filingUrl(cik, accession, primary),
      tags,
      importance,
    });
  }
  out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  return { cik, name: doc.name, filings: out };
}

/** `base` is https://data.sec.gov. */
export async function fetchSubmissions(base: string, cik: number, userAgent: string): Promise<unknown> {
  const url = `${base.replace(/\/$/, '')}/submissions/CIK${String(cik).padStart(10, '0')}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': userAgent } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}
