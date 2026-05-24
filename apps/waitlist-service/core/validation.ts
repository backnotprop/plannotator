// Validation + light enrichment for waitlist signups. Pure functions so they
// can be reused in both the worker and (eventually) a Bun-side dev target.

export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "duck.com",
  "hey.com",
]);

// Conservative — strict-enough to catch typos, lenient-enough to admit unicode
// TLDs and plus-addressing. Real verification happens by sending email.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

// Team-size buckets the form sends as slugs. The marketing page renders the
// display strings (e.g. "Just me", "2–5"); the slug is what travels over the
// wire so SQL stays clean and we don't have to deal with em-dash encoding.
export const ALLOWED_TEAM_SIZES = new Set([
  "solo",
  "2-5",
  "6-20",
  "21-50",
  "50+",
]);

export interface RawSignup {
  email?: unknown;
  company?: unknown;
  team_size?: unknown;
  note?: unknown;
  is_contributor?: unknown;
  // Cloudflare Turnstile token from the client widget. Validated separately
  // in the handler against the siteverify endpoint.
  turnstile_token?: unknown;
  // Honeypot — bots tend to fill every visible-looking field.
  website?: unknown;
}

export interface NormalizedSignup {
  email: string;
  company: string;
  company_inferred: boolean;
  team_size: string;
  note: string | null;
  is_contributor: boolean;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public status: number = 400
  ) {
    super(message);
  }
}

function trimStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Common compound TLDs / public suffixes. Not a full public-suffix list
// (that would be ~10k entries from publicsuffix.org); just the ones most
// people working in tech actually use. Used to pick the right label in
// `inferCompanyFromEmail` — e.g. for `dept.acme.co.uk` the label is "acme",
// not "co".
const COMPOUND_TLDS = new Set([
  "co.uk",
  "co.jp",
  "co.kr",
  "co.in",
  "co.nz",
  "co.za",
  "ac.uk",
  "gov.uk",
  "org.uk",
  "ne.jp",
  "or.jp",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.ar",
]);

function inferCompanyFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (FREE_EMAIL_DOMAINS.has(domain)) return null;

  const parts = domain.replace(/^www\./, "").split(".");
  if (parts.length < 2) return null;

  // Detect whether the last two segments form a known compound TLD; if so
  // the registrable label is the segment immediately before it. Otherwise
  // it's the segment immediately before the single-segment TLD.
  const lastTwo = parts.slice(-2).join(".");
  const tldSegments = COMPOUND_TLDS.has(lastTwo) ? 2 : 1;
  const labelIndex = parts.length - tldSegments - 1;
  if (labelIndex < 0) return null;

  const label = parts[labelIndex];
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function normalizeSignup(raw: RawSignup): NormalizedSignup {
  // Honeypot — silently fail if filled. We still 200 the request from the
  // caller's POV (see handler), but no row is written.
  if (typeof raw.website === "string" && raw.website.trim() !== "") {
    throw new ValidationError("__honeypot__", 200);
  }

  const emailRaw = trimStr(raw.email, 320);
  if (!emailRaw) throw new ValidationError("Email is required");
  const email = emailRaw.toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ValidationError("Email looks invalid");

  // Company is required by the form. If a caller leaves it blank we still
  // try the email-domain inference — better to capture *something* than to
  // 400 someone who hit "submit" without filling the field.
  let company = trimStr(raw.company, 160);
  let companyInferred = false;
  if (!company) {
    const inferred = inferCompanyFromEmail(email);
    if (inferred) {
      company = inferred;
      companyInferred = true;
    }
  }
  if (!company) throw new ValidationError("Company is required");

  const teamSizeRaw = trimStr(raw.team_size, 16)?.toLowerCase() ?? null;
  if (!teamSizeRaw || !ALLOWED_TEAM_SIZES.has(teamSizeRaw)) {
    throw new ValidationError("Team size is required");
  }

  const note = trimStr(raw.note, 1000);
  const is_contributor = raw.is_contributor === true;

  return {
    email,
    company,
    company_inferred: companyInferred,
    team_size: teamSizeRaw,
    note,
    is_contributor,
  };
}
