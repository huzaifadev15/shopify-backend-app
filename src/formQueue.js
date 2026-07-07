import "dotenv/config";
import { Queue, Worker, UnrecoverableError } from "bullmq";

// ── Retry queue for external store form submissions ──────────────────────────
// When a form send to outjackets/neonsigns fails because the store is down
// (network error, timeout, 5xx), the payload is saved as a BullMQ job in
// Upstash Redis and retried automatically with exponential backoff. A 4xx
// response is treated as permanent (bad payload) and is never retried.

export const STORE_ENDPOINTS = {
  outjackets: "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public",
  neonsigns: "https://neonsigns.us.com/api/forms/for-category/public",
};

const QUEUE_NAME = "store-form-submissions";
const SEND_TIMEOUT_MS = Number(process.env.FORM_SEND_TIMEOUT_MS || 15_000);
const RETRY_ATTEMPTS = Number(process.env.FORM_RETRY_ATTEMPTS || 48);
const RETRY_BASE_DELAY_MS = Number(process.env.FORM_RETRY_BASE_DELAY_MS || 60_000);
const RETRY_MAX_DELAY_MS = Number(process.env.FORM_RETRY_MAX_DELAY_MS || 30 * 60_000);

let formQueue = null;
let formWorker = null;

function redisConnectionOptions() {
  const restUrl = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!restUrl || !token) return null;
  return {
    // Upstash exposes the native Redis protocol on the same host as the REST
    // API, and the REST token doubles as the Redis password.
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
export async function enqueueFormRetry(store, payload, reason) {
  if (!formQueue) {
    console.error(`[FORM_QUEUE] Queue disabled — LOST submission for ${store}. Payload: ${JSON.stringify(payload)}`);
    return false;
  }
  try {
    const job = await formQueue.add(
      store,
      { store, payload, firstError: reason || "unknown" },
      {
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
    // Redis itself is unreachable — log the full payload so it can be recovered by hand.
    console.error(`[FORM_QUEUE] CRITICAL: could not enqueue ${store} submission (${error?.message}). Payload: ${JSON.stringify(payload)}`);
    return false;
  }
}

// Tries to deliver now; on a retryable failure the payload is queued.
// Returns the sendToStore result plus { queued } when queueing happened.
export async function submitFormToStore(store, payload) {
  const result = await sendToStore(store, payload);
  if (result.ok) return result;
  if (result.permanent) {
    console.warn(`[FORM_QUEUE] ${store} rejected submission permanently (HTTP ${result.status}) — not retrying.`);
    return result;
  }
  const queued = await enqueueFormRetry(store, payload, result.error);
  return { ...result, queued };
}

export function initFormQueue() {
  const connection = redisConnectionOptions();
  if (!connection) {
    console.warn("[FORM_QUEUE] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — retry queue disabled, failed sends will be lost.");
    return false;
  }

  formQueue = new Queue(QUEUE_NAME, { connection });
  formQueue.on("error", (error) => console.error("[FORM_QUEUE] Queue error:", error?.message));

  formWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { store, payload } = job.data;
      const result = await sendToStore(store, payload);
      if (result.ok) return { status: result.status };
      if (result.permanent) {
        throw new UnrecoverableError(`${store} rejected submission (HTTP ${result.status})`);
      }
      throw new Error(result.error);
    },
    {
      connection,
      concurrency: 2,
      // Poll gently — Upstash bills per command and the queue is usually empty.
      drainDelay: 60,
      stalledInterval: 5 * 60_000,
      settings: { backoffStrategy: retryBackoff },
    }
  );

  formWorker.on("completed", (job) => {
    console.log(`[FORM_QUEUE] Delivered queued ${job.name} submission (job ${job.id}) after ${job.attemptsMade} attempt(s).`);
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

// Puts dead-lettered jobs back in the queue for a fresh round of retries.
export async function retryDeadLetterJobs() {
  if (!formQueue) return { enabled: false, retried: 0 };
  const failed = await formQueue.getFailed(0, 99);
  for (const job of failed) {
    await job.retry();
  }
  return { enabled: true, retried: failed.length };
}
