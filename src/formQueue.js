import "dotenv/config";

// ── External store form submissions ───────────────────────────────────────
// Forwards form payloads to outjackets/neonsigns. A 4xx response is treated
// as permanent (bad payload); network errors/timeouts/5xx are logged but not
// retried.

export const STORE_ENDPOINTS = {
  outjackets: "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public",
  neonsigns: "https://neonsigns.us.com/api/forms/for-category/public",
};

const SEND_TIMEOUT_MS = Number(process.env.FORM_SEND_TIMEOUT_MS || 15_000);

// Sends the payload to one store. Never throws — returns:
//   { ok: true,  status, data }                     → delivered
//   { ok: false, permanent: true, status, data }    → store rejected it (4xx), retrying won't help
//   { ok: false, permanent: false, error }          → store unreachable/5xx
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

export async function submitFormToStore(store, payload) {
  const result = await sendToStore(store, payload);

  if (result.ok) {
    return result;
  }

  if (result.permanent) {
    console.warn(`[FORM_SUBMIT] ${store} rejected submission permanently (HTTP ${result.status}) — not retrying.`);
    return result;
  }

  console.error(`[FORM_SUBMIT] ${store} unreachable — LOST submission. Payload: ${JSON.stringify(payload)}`);
  return result;
}
