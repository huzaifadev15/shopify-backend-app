// OpenAI Ads Conversions API client.
//
// Server-side counterpart to the browser-side `oaiq` pixel. The theme pixel
// still fires `page_viewed`, `items_added`, `checkout_started` from the
// browser; `lead_created` and `order_created` are server-only, so there is
// nothing to de-duplicate against — we just use stable, replayable `id`s so
// retries never double-count.
//
// Docs: https://developers.openai.com/ads/conversions-api
//
// All fields in the `user` object are optional. Email, phone, names and
// external ids must be sent as SHA-256 (lowercase hex), inside the plural
// *_sha256 lists. Geographic fields and ip_address/user_agent are raw.

import crypto from "crypto";
import geoip from "geoip-lite";

const ENDPOINT = "https://bzr.openai.com/v1/events";
const PIXEL_ID = process.env.OPENAI_PIXEL_ID || "";
const API_KEY = process.env.OPENAI_CONVERSIONS_API_KEY || "";

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeEmail(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return sha256Hex(trimmed);
}

// OpenAI's rule: digits only, country code kept, no leading `+` or zeros,
// 8–15 digits total. We assume US/CA numbers without a country code and
// prepend `1`, which matches how Shopify stores phones for this store.
export function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, "");
  digits = digits.replace(/^0+/, "");
  if (digits.length === 10) digits = "1" + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return sha256Hex(digits);
}

export function normalizeName(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toLowerCase().replace(/[\s\p{P}]+/gu, "");
  if (!cleaned) return null;
  return sha256Hex(cleaned);
}

function splitName(full) {
  if (!full) return { first: null, last: null };
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

// Fill missing city/region/country from the IP. The MaxMind lookup is cheap
// (offline, in-process) and gives OpenAI something to match on even when the
// quote form didn't collect an address.
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

export function buildUser({
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
  obref,
  externalId,
} = {}) {
  const user = {};

  if (!firstName && !lastName && fullName) {
    const parts = splitName(fullName);
    firstName = firstName || parts.first;
    lastName = lastName || parts.last;
  }

  const emailHash = normalizeEmail(email);
  if (emailHash) user.emails_sha256 = [emailHash];

  const phoneHash = normalizePhone(phone);
  if (phoneHash) user.phone_numbers_sha256 = [phoneHash];

  const firstHash = normalizeName(firstName);
  if (firstHash) user.first_names_sha256 = [firstHash];

  const lastHash = normalizeName(lastName);
  if (lastHash) user.last_names_sha256 = [lastHash];

  if (externalId) user.external_ids_sha256 = [sha256Hex(String(externalId))];

  // Prefer explicit fields; fill the gaps from IP geolocation.
  const geo = (!city || !region || !country) ? geoFromIp(ip) : null;
  const finalCity = city || geo?.city;
  const finalRegion = region || geo?.region;
  const finalCountry = country || geo?.country;

  if (finalCity) user.cities = [String(finalCity)];
  if (finalRegion) user.regions = [String(finalRegion)];
  if (postalCode) user.postal_codes = [String(postalCode)];
  if (finalCountry) user.countries = [String(finalCountry)];

  if (ip) user.ip_address = String(ip);
  if (userAgent) user.user_agent = String(userAgent);
  if (obref) user.obref = String(obref);

  return user;
}

// `amount` is in the minor currency unit (cents) and must be an integer.
export function toMinorUnits(value) {
  const number = parseFloat(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  if (!isFinite(number)) return 0;
  return Math.round(number * 100);
}

function logError(label, err) {
  console.error(`[OPENAI_CAPI] ${label}`, err?.message || err);
}

async function postEvents(events) {
  const url = `${ENDPOINT}?pid=${encodeURIComponent(PIXEL_ID)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      logError(`HTTP ${response.status}`, text);
      return { ok: false, status: response.status, body: text };
    }
    console.log(`[OPENAI_CAPI] sent ${events.length} event(s):`, text || "ok");
    return { ok: true, status: response.status, body: text };
  } catch (err) {
    logError("fetch failed", err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget wrapper. Resolves when the API responds or times out, but
// callers never await it in a way that would delay the HTTP response — see
// `sendEventAsync` below for the recommended usage.
export async function sendEvent({
  id,
  type,
  dataObj,
  user,
  sourceUrl,
  timestampMs,
}) {
  if (!PIXEL_ID || !API_KEY) {
    // Local dev / missing config: no-op so we don't spam OpenAI with 401s.
    console.log(`[OPENAI_CAPI] skip ${type} (${id}) — pixel id or api key not set`);
    return { ok: false, skipped: true };
  }
  if (!id || !type) {
    logError("missing id or type", { id, type });
    return { ok: false, skipped: true };
  }

  const event = {
    id: String(id),
    type: String(type),
    timestamp_ms: timestampMs || Date.now(),
    action_source: "web",
  };
  if (sourceUrl) event.source_url = String(sourceUrl);
  if (dataObj) event.data = dataObj;
  if (user && Object.keys(user).length) event.user = user;

  return postEvents([event]);
}

// Fire-and-forget: never await this on a request path. Logs any failure.
export function sendEventAsync(payload) {
  // eslint-disable-next-line promise/catch-or-return
  Promise.resolve()
    .then(() => sendEvent(payload))
    .catch((err) => logError("async send threw", err));
}

export function getClientIpFromReq(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  const candidate =
    (typeof chain === "string" && chain.split(",")[0]) ||
    req.headers["x-real-ip"] ||
    req.headers["cf-connecting-ip"] ||
    req.socket?.remoteAddress ||
    "";
  const ip = String(candidate).trim().replace(/^::ffff:/i, "");
  return ip || null;
}

export const openaiConfig = {
  pixelId: PIXEL_ID,
  enabled: Boolean(PIXEL_ID && API_KEY),
};
