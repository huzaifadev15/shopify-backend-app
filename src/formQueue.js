import "dotenv/config";
import { createHash } from "crypto";
import {
  Client as QStashClient,
  Receiver as QStashReceiver,
} from "@upstash/qstash";
import { Redis } from "@upstash/redis";

// ── External store form submissions with QStash retry queue ──────────────────
// On success  → done.
// On 4xx      → permanent rejection, no retry.
// On network error / timeout / 5xx → publish to QStash.
//   QStash calls POST /api/queue/deliver which tries again.
//   On failure the endpoint re-publishes with a longer delay (our own backoff).
//   This works on Vercel/serverless — no persistent worker needed.

export const STORE_ENDPOINTS = {
  outjackets:
    "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public",
  neonsigns: "https://dash.fineystpatches.com/api/forms/for-category/public",
};

const SEND_TIMEOUT_MS = Number(process.env.FORM_SEND_TIMEOUT_MS || 15_000);
const MAX_RETRY_ATTEMPTS = Number(process.env.FORM_MAX_RETRY_ATTEMPTS || 48);
const RETRY_BASE_DELAY_S = Number(process.env.FORM_RETRY_BASE_DELAY_S || 60);
const RETRY_MAX_DELAY_S = Number(process.env.FORM_RETRY_MAX_DELAY_S || 1_800); // 30 min
const DELIVERED_TTL_SEC = 48 * 3600;
const APP_URL = (process.env.APP_URL || "").trim().replace(/\/$/, "");
const QSTASH_TOKEN = (process.env.QSTASH_TOKEN || "").trim();
const QSTASH_CURRENT_KEY = (
  process.env.QSTASH_CURRENT_SIGNING_KEY || ""
).trim();
const QSTASH_NEXT_KEY = (process.env.QSTASH_NEXT_SIGNING_KEY || "").trim();
const QSTASH_BASE_URL = (
  process.env.QSTASH_URL || "https://qstash-eu-central-1.upstash.io"
).trim();

// ── Clients ───────────────────────────────────────────────────────────────────
let qstash = null;
let redis = null;
export let qstashReceiver = null;

function getQStash() {
  if (!qstash) {
    if (!QSTASH_TOKEN) throw new Error("QSTASH_TOKEN is not set.");
    qstash = new QStashClient({
      token: QSTASH_TOKEN,
      baseUrl: QSTASH_BASE_URL,
    });
  }
  return qstash;
}

function getRedis() {
  if (!redis) {
    const url = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
    const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
    if (!url || !token)
      throw new Error(
        "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set.",
      );
    redis = new Redis({ url, token });
  }
  return redis;
}

export function getQStashReceiver() {
  if (!qstashReceiver) {
    if (!QSTASH_CURRENT_KEY || !QSTASH_NEXT_KEY)
      throw new Error("QStash signing keys not set.");
    qstashReceiver = new QStashReceiver({
      currentSigningKey: QSTASH_CURRENT_KEY,
      nextSigningKey: QSTASH_NEXT_KEY,
    });
  }
  return qstashReceiver;
}

// ── Deduplication helpers ─────────────────────────────────────────────────────
// Prevents re-delivery when a store received a form but the HTTP response
// timed out on our side (the most common cause of duplicate submissions).

export function makeSubmissionId(store, payload) {
  const orderId = payload?.shopifyOrderId || payload?.shopifyDraftOrderId;
  const fingerprint = orderId
    ? `${store}|${orderId}`
    : [
        store,
        payload?.email || "",
        payload?.patchType || "",
        payload?.quantity || "",
        payload?.subTotal || "",
        Math.floor(Date.now() / 60_000), // round to minute — catches double-clicks
      ].join("|");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 40);
}

async function markDelivered(submissionId) {
  try {
    await getRedis().set(`delivered:${submissionId}`, "1", {
      ex: DELIVERED_TTL_SEC,
    });
  } catch (_error) {
    /* non-fatal */
  }
}

async function isDelivered(submissionId) {
  try {
    return (await getRedis().get(`delivered:${submissionId}`)) === "1";
  } catch (_error) {
    return false;
  }
}

// ── Backoff schedule ──────────────────────────────────────────────────────────
// attempt 1 → 1 min, 2 → 2 min, 3 → 4 min … capped at 30 min.
function retryDelaySeconds(attempt) {
  return Math.min(
    RETRY_MAX_DELAY_S,
    RETRY_BASE_DELAY_S * 2 ** Math.max(0, attempt - 1),
  );
}

// ── Core send ─────────────────────────────────────────────────────────────────
// Returns:
//   { ok: true,  status, data }                   → delivered
//   { ok: false, permanent: true,  status, data } → 4xx, retrying won't help
//   { ok: false, permanent: false, error }        → network/5xx, worth retrying
export async function sendToStore(store, payload) {
  const url = STORE_ENDPOINTS[store];
  if (!url)
    return {
      ok: false,
      permanent: true,
      status: 0,
      data: { message: `Unknown store "${store}"` },
    };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_e) {
      data = { raw: raw.slice(0, 300) };
    }

    if (response.ok) return { ok: true, status: response.status, data };
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, permanent: true, status: response.status, data };
    }
    return {
      ok: false,
      permanent: false,
      error: `HTTP ${response.status} from ${store}`,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `Timed out after ${SEND_TIMEOUT_MS}ms`
        : error?.message || String(error);
    return { ok: false, permanent: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Queue a retry via QStash ──────────────────────────────────────────────────
export async function enqueueRetry(store, payload, submissionId, attempt) {
  if (!APP_URL) {
    console.error(
      "[FORM_QUEUE] APP_URL not set — cannot enqueue retry. Payload:",
      JSON.stringify(payload),
    );
    return false;
  }
  const delaySec = retryDelaySeconds(attempt);
  try {
    await getQStash().publishJSON({
      url: `${APP_URL}/api/queue/deliver`,
      body: { store, payload, submissionId, attempt },
      delay: delaySec,
    });
    console.log(
      `[FORM_QUEUE] Queued ${store} retry #${attempt} in ${delaySec}s (id: ${submissionId})`,
    );
    return true;
  } catch (error) {
    console.error(
      `[FORM_QUEUE] CRITICAL: failed to enqueue ${store} retry (${error?.message}). Payload:`,
      JSON.stringify(payload),
    );
    return false;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
// Called from route handlers. Tries to deliver immediately; queues on failure.
export async function submitFormToStore(store, payload) {
  const submissionId = makeSubmissionId(store, payload);

  if (await isDelivered(submissionId)) {
    console.log(
      `[FORM_QUEUE] Skipping ${store} — already delivered (id: ${submissionId})`,
    );
    return { ok: true, skipped: true };
  }

  const result = await sendToStore(store, payload);

  if (result.ok) {
    await markDelivered(submissionId);
    return result;
  }

  if (result.permanent) {
    console.warn(
      `[FORM_QUEUE] ${store} permanently rejected submission (HTTP ${result.status})`,
    );
    return result;
  }

  // Retryable failure — hand off to QStash
  const queued = await enqueueRetry(store, payload, submissionId, 1);
  return { ...result, queued };
}

// ── Delivery handler (called by /api/queue/deliver) ───────────────────────────
// QStash calls this endpoint. We always return 200 so QStash doesn't retry
// on its own — we manage the full retry chain ourselves by re-publishing.
export async function handleDelivery({
  store,
  payload,
  submissionId,
  attempt,
}) {
  if (await isDelivered(submissionId)) {
    console.log(
      `[FORM_QUEUE] Retry #${attempt} skipped — already delivered (id: ${submissionId})`,
    );
    return { ok: true, skipped: true };
  }

  const result = await sendToStore(store, payload);

  if (result.ok) {
    await markDelivered(submissionId);
    console.log(
      `[FORM_QUEUE] Delivered ${store} on retry #${attempt} (id: ${submissionId})`,
    );
    return { ok: true, delivered: true, attempt };
  }

  if (result.permanent) {
    console.warn(
      `[FORM_QUEUE] ${store} permanently rejected on retry #${attempt} — giving up.`,
    );
    return { ok: false, permanent: true };
  }

  // Still failing — schedule next retry if attempts remain
  if (attempt >= MAX_RETRY_ATTEMPTS) {
    console.error(
      `[FORM_QUEUE] DEAD-LETTER: ${store} failed after ${attempt} attempts (id: ${submissionId}). Last error: ${result.error}`,
    );
    return { ok: false, exhausted: true, attempt };
  }

  await enqueueRetry(store, payload, submissionId, attempt + 1);
  return { ok: false, retrying: true, nextAttempt: attempt + 1 };
}
