// Meta (Facebook) Conversions API client.
//
// Server-side counterpart to the browser-side Meta pixel. To de-duplicate,
// the browser pixel must fire the same event with the same `eventID` that we
// pass here as `event_id` (Meta drops the duplicate within 48h). Events that
// only exist server-side (Lead from the quote form) just use a stable,
// replayable id so retries never double-count.
//
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api
//
// PII (email, phone, names, city, state, zip, country, external_id) is sent as
// SHA-256 lowercase hex. client_ip_address, client_user_agent, fbp and fbc are
// sent raw.

import crypto from "crypto";
import geoip from "geoip-lite";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const PIXEL_ID = (process.env.META_PIXEL_ID || "").trim();
const ACCESS_TOKEN = (process.env.META_CAPI_ACCESS_TOKEN || "").trim();
// Set to a code from Events Manager > Test events to see events live without
// them counting toward optimisation.
const TEST_EVENT_CODE = (process.env.META_TEST_EVENT_CODE || "").trim();

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashLower(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().toLowerCase();
  return cleaned ? sha256Hex(cleaned) : null;
}

export function normalizeEmail(raw) {
  const value = raw ? String(raw).trim().toLowerCase() : "";
  return value.includes("@") ? sha256Hex(value) : null;
}

// Digits only, country code kept. Assumes US/CA for bare 10-digit numbers.
export function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = "1" + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return sha256Hex(digits);
}

function normalizeName(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toLowerCase().replace(/[\s\p{P}]+/gu, "");
  return cleaned ? sha256Hex(cleaned) : null;
}

function splitName(full) {
  if (!full) return { first: null, last: null };
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function geoFromIp(ip) {
  if (!ip) return null;
  try {
    const row = geoip.lookup(ip);
    if (!row) return null;
    return {
      city: row.city || null,
      region: row.region || null,
      country: row.country || null,
    };
  } catch {
    return null;
  }
}

// Meta wants `fbc` as `fb.1.<ms>.<fbclid>`. If the caller only has the raw
// fbclid from the landing URL, build it.
export function buildFbc(fbc, fbclid) {
  if (fbc) return String(fbc);
  if (fbclid) return `fb.1.${Date.now()}.${String(fbclid)}`;
  return null;
}

export function buildUserData({
  email,
  phone,
  firstName,
  lastName,
  fullName,
  city,
  region,
  postalCode,
  country,
  ip,
  userAgent,
  fbp,
  fbc,
  fbclid,
  externalId,
} = {}) {
  const user = {};

  if (!firstName && !lastName && fullName) {
    const parts = splitName(fullName);
    firstName = parts.first;
    lastName = parts.last;
  }

  const em = normalizeEmail(email);
  if (em) user.em = [em];
  const ph = normalizePhone(phone);
  if (ph) user.ph = [ph];
  const fn = normalizeName(firstName);
  if (fn) user.fn = [fn];
  const ln = normalizeName(lastName);
  if (ln) user.ln = [ln];
  if (externalId) user.external_id = [sha256Hex(String(externalId).trim().toLowerCase())];

  const geo = !city || !region || !country ? geoFromIp(ip) : null;
  const ct = hashLower(String(city || geo?.city || "").replace(/\s+/g, ""));
  if (ct) user.ct = [ct];
  const st = hashLower(region || geo?.region);
  if (st) user.st = [st];
  const zp = hashLower(postalCode);
  if (zp) user.zp = [zp];
  const cn = hashLower(country || geo?.country);
  if (cn) user.country = [cn];

  if (ip) user.client_ip_address = String(ip);
  if (userAgent) user.client_user_agent = String(userAgent);
  if (fbp) user.fbp = String(fbp);
  const finalFbc = buildFbc(fbc, fbclid);
  if (finalFbc) user.fbc = finalFbc;

  return user;
}

// Meta takes `value` as a decimal in major units (dollars), not cents.
export function toValue(raw) {
  const number = parseFloat(String(raw ?? "0").replace(/[^0-9.-]/g, ""));
  return isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function logError(label, err) {
  console.error(`[META_CAPI] ${label}`, err?.message || err);
}

async function postEvents(events) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(PIXEL_ID)}/events`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const body = { data: events };
    if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      logError(`HTTP ${response.status}`, text);
      return { ok: false, status: response.status, body: text };
    }
    console.log(`[META_CAPI] sent ${events.length} event(s):`, text || "ok");
    return { ok: true, status: response.status, body: text };
  } catch (err) {
    logError("fetch failed", err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendEvent({
  eventId,
  eventName,
  customData,
  userData,
  sourceUrl,
  timestampMs,
}) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.log(`[META_CAPI] skip ${eventName} (${eventId}) — pixel id or access token not set`);
    return { ok: false, skipped: true };
  }
  if (!eventId || !eventName) {
    logError("missing eventId or eventName", { eventId, eventName });
    return { ok: false, skipped: true };
  }

  const event = {
    event_name: String(eventName),
    event_id: String(eventId),
    // Meta wants seconds, not ms.
    event_time: Math.floor((timestampMs || Date.now()) / 1000),
    action_source: "website",
  };
  if (sourceUrl) event.event_source_url = String(sourceUrl);
  if (customData && Object.keys(customData).length) event.custom_data = customData;
  if (userData && Object.keys(userData).length) event.user_data = userData;

  return postEvents([event]);
}

// Fire-and-forget: never await this on a request path. Logs any failure.
export function sendEventAsync(payload) {
  Promise.resolve()
    .then(() => sendEvent(payload))
    .catch((err) => logError("async send threw", err));
}

export const metaConfig = {
  pixelId: PIXEL_ID,
  enabled: Boolean(PIXEL_ID && ACCESS_TOKEN),
};
