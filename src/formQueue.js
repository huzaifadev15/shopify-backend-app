import "dotenv/config";
import { createHash } from "crypto";
import { Redis } from "ioredis";
import { Queue, Worker, UnrecoverableError } from "bullmq";

// ── Retry queue for external store form submissions ──────────────────────────
// When a form send to outjackets/neonsigns fails because the store is down
// (network error, timeout, 5xx), the payload is saved as a BullMQ job in
// Upstash Redis and retried automatically with exponential backoff. A 4xx
// response is treated as permanent (bad payload) and is never retried.
//
// Deduplication strategy (prevents double-delivery when a response times out
// after the store already received the form):
//   1. Every submission gets a stable submissionId derived from the Shopify
//      order ID (or a hash of key payload fields when there is no order ID).
//   2. On successful delivery we write delivered:<submissionId> = 1 (48h TTL)
//      to Redis. The worker checks this flag before every retry attempt.
//   3. BullMQ jobs use submissionId as their jobId — so queuing the same
//      submission twice is a no-op (BullMQ ignores duplicate jobIds).

export const STORE_ENDPOINTS = {
  outjackets: "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public",
  neonsigns: "https://neonsigns.us.com/api/forms/for-category/public",
};

const QUEUE_NAME = "store-form-submissions";
const SEND_TIMEOUT_MS = Number(process.env.FORM_SEND_TIMEOUT_MS || 15_000);
const RETRY_ATTEMPTS = Number(process.env.FORM_RETRY_ATTEMPTS || 48);
const RETRY_BASE_DELAY_MS = Number(process.env.FORM_RETRY_BASE_DELAY_MS || 60_000);
const RETRY_MAX_DELAY_MS = Number(process.env.FORM_RETRY_MAX_DELAY_MS || 30 * 60_000);
const DELIVERED_TTL_SEC = 48 * 3600;

let formQueue = null;
let formWorker = null;
let redisClient = null;

function redisConnectionOptions() {
  const restUrl = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!restUrl || !token) return null;
  return {
    host: restUrl.replace(/^https?:\/\//i, "").replace(/\/+$/g, ""),
    port: 6379,
    username: "default",
    password: token,
    tls: {},
    maxRetriesPerRequest: null,
  };
}

// Delays: 1m, 2m, 4m, 8m, 16m, then every 30m (capped) until attempts run out.
function retryBackoff(attemptsMade) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1));
}

// Generates a stable ID for a (store, payload) pair.
// Uses the Shopify order ID when available; otherwise hashes key fields.
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
        Math.floor(Date.now() / 60_000), // rounded to minute
      ].join("|");
  // SHA-256 hex — no colons, slashes or other chars BullMQ forbids in jobIds
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 40);
}

async function markDelivered(submissionId) {
  if (!redisClient) return;
  try {
    await redisClient.set(`delivered:${submissionId}`, "1", "EX", DELIVERED_TTL_SEC);
  } catch (_error) { /* non-fatal */ }
}

async function isDelivered(submissionId) {
  if (!redisClient) return false;
  try {
    return (await redisClient.get(`delivered:${submissionId}`)) === "1";
  } catch (_error) {
    return false;
  }
}

// Sends the payload to one store. Never throws — returns:
//   { ok: true,  status, data }                     → delivered
//   { ok: false, permanent: true, status, data }    → store rejected it (4xx), retrying won't help
//   { ok: false, permanent: false, error }          → store unreachable/5xx, worth retrying
export async function sendToStore(store, payload) {
  const url = STORE_ENDPOINTS[store];
  if (!url) {
    return { ok: false, permanent: true, status: 0, data: { message: `Unknown store "${store}"` } };
  }

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
    } catch (_error) {
      data = { raw: raw.slice(0, 300) };
    }

    if (response.ok) return { ok: true, status: response.status, data };
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, permanent: true, status: response.status, data };
    }
    return { ok: false, permanent: false, error: `HTTP ${response.status} from ${store}` };
  } catch (error) {
    const message = error?.name === "AbortError" ? `Timed out after ${SEND_TIMEOUT_MS}ms` : (error?.message || String(error));
    return { ok: false, permanent: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

// Saves a failed submission so the worker retries it later.
// jobId = submissionId ensures the same form can never be queued twice.
export async function enqueueFormRetry(store, payload, reason, submissionId) {
  if (!formQueue) {
    console.error(`[FORM_QUEUE] Queue disabled — LOST submission for ${store}. Payload: ${JSON.stringify(payload)}`);
    return false;
  }
  try {
    const job = await formQueue.add(
      store,
      { store, payload, firstError: reason || "unknown", submissionId },
      {
        jobId: submissionId,
        attempts: RETRY_ATTEMPTS,
        backoff: { type: "custom" },
        delay: RETRY_BASE_DELAY_MS,
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { count: 1000 },
      }
    );
    console.log(`[FORM_QUEUE] Queued ${store} submission (job ${job.id}) — first error: ${reason}`);
    return true;
  } catch (error) {
    console.error(`[FORM_QUEUE] CRITICAL: could not enqueue ${store} submission (${error?.message}). Payload: ${JSON.stringify(payload)}`);
    return false;
  }
}

// Tries to deliver now; on a retryable failure the payload is queued.
// Returns the sendToStore result plus { queued } when queueing happened.
export async function submitFormToStore(store, payload) {
  const submissionId = makeSubmissionId(store, payload);

  // Skip if already delivered (handles the case where the store received the
  // form but the HTTP response timed out on our side — the most common cause
  // of duplicate submissions).
  if (await isDelivered(submissionId)) {
    console.log(`[FORM_QUEUE] Skipping ${store} — already delivered (id: ${submissionId})`);
    return { ok: true, skipped: true };
  }

  const result = await sendToStore(store, payload);

  if (result.ok) {
    await markDelivered(submissionId);
    return result;
  }

  if (result.permanent) {
    console.warn(`[FORM_QUEUE] ${store} rejected submission permanently (HTTP ${result.status}) — not retrying.`);
    return result;
  }

  const queued = await enqueueFormRetry(store, payload, result.error, submissionId);
  return { ...result, queued };
}

export function initFormQueue() {
  const connection = redisConnectionOptions();
  if (!connection) {
    console.warn("[FORM_QUEUE] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — retry queue disabled, failed sends will be lost.");
    return false;
  }

  // Separate ioredis client for direct GET/SET (delivered flags).
  redisClient = new Redis({ ...connection, maxRetriesPerRequest: 3, lazyConnect: true });
  redisClient.on("error", (error) => console.error("[FORM_QUEUE] Redis client error:", error?.message));

  formQueue = new Queue(QUEUE_NAME, { connection });
  formQueue.on("error", (error) => console.error("[FORM_QUEUE] Queue error:", error?.message));

  formWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { store, payload, submissionId } = job.data;

      // Guard against re-delivery: if the form was already sent (e.g. a
      // previous attempt succeeded but the response timed out), skip.
      if (submissionId && await isDelivered(submissionId)) {
        console.log(`[FORM_QUEUE] Job ${job.id} (${store}) already delivered — skipping.`);
        return { skipped: true };
      }

      const result = await sendToStore(store, payload);
      if (result.ok) {
        if (submissionId) await markDelivered(submissionId);
        return { status: result.status };
      }
      if (result.permanent) {
        throw new UnrecoverableError(`${store} rejected submission (HTTP ${result.status})`);
      }
      throw new Error(result.error);
    },
    {
      connection,
      concurrency: 2,
      drainDelay: 60,
      stalledInterval: 5 * 60_000,
      settings: { backoffStrategy: retryBackoff },
    }
  );

  formWorker.on("completed", (job) => {
    const skipped = job.returnvalue?.skipped;
    console.log(`[FORM_QUEUE] Job ${job.id} (${job.name}) ${skipped ? "skipped (already delivered)" : `delivered after ${job.attemptsMade} attempt(s)`}.`);
  });
  formWorker.on("failed", (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts?.attempts || 1);
    if (exhausted || error instanceof UnrecoverableError) {
      console.error(`[FORM_QUEUE] Job ${job.id} (${job.name}) moved to dead-letter after ${job.attemptsMade} attempt(s): ${error?.message}`);
    } else {
      console.warn(`[FORM_QUEUE] Job ${job.id} (${job.name}) attempt ${job.attemptsMade} failed (${error?.message}) — next retry in ~${Math.round(retryBackoff(job.attemptsMade) / 60_000)}m.`);
    }
  });
  formWorker.on("error", (error) => console.error("[FORM_QUEUE] Worker error:", error?.message));

  console.log(`[FORM_QUEUE] Retry queue enabled (${connection.host}) — up to ${RETRY_ATTEMPTS} attempts per submission.`);
  return true;
}

export async function getQueueStatus() {
  if (!formQueue) return { enabled: false };
  const counts = await formQueue.getJobCounts("waiting", "delayed", "active", "failed", "completed");
  const describe = (job) => ({
    id: job.id,
    store: job.name,
    attemptsMade: job.attemptsMade,
    firstError: job.data?.firstError,
    lastError: job.failedReason,
    createdAt: new Date(job.timestamp).toISOString(),
    email: job.data?.payload?.email,
  });
  const [delayed, failed] = await Promise.all([
    formQueue.getDelayed(0, 24),
    formQueue.getFailed(0, 24),
  ]);
  return {
    enabled: true,
    counts,
    pendingRetries: delayed.map(describe),
    deadLetter: failed.map(describe),
  };
}

export async function retryDeadLetterJobs() {
  if (!formQueue) return { enabled: false, retried: 0 };
  const failed = await formQueue.getFailed(0, 99);
  for (const job of failed) {
    await job.retry();
  }
  return { enabled: true, retried: failed.length };
}
