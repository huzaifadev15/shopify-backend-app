import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFile } from "fs/promises";
import path from "path";
import multer from "multer";
import { fal } from "@fal-ai/client";
import { loadPricing, matchRows, quoteFromRows } from "./pricing.js";
import { signQuote } from "./token.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
const defaultCorsOrigin = process.env.STOREFRONT_ORIGIN || (process.env.SHOPIFY_SHOP_DOMAIN ? `https://${normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN)}` : "");
const rawCorsOrigin = process.env.CORS_ORIGIN || defaultCorsOrigin;
const allowAllOrigins = rawCorsOrigin.split(",").map((s) => s.trim()).includes("*");
const allowedOrigins = allowAllOrigins
  ? []
  : rawCorsOrigin
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (allowAllOrigins || !origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);

const PORT = Number(process.env.PORT || 8787);
const QUOTE_SECRET = process.env.QUOTE_SECRET || "dev-secret";
const PRICING_FILE = process.env.PRICING_FILE || "./data/pricing.json";
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const SHOPIFY_API_KEY = (process.env.SHOPIFY_API_KEY || "").trim();
const SHOPIFY_API_SECRET = (process.env.SHOPIFY_API_SECRET || "").trim();
const APP_URL = (process.env.APP_URL || "").trim().replace(/\/$/, "");
const SHOPIFY_SCOPES = (process.env.SHOPIFY_SCOPES || "write_files,read_files,write_discounts,read_discounts,write_cart_transforms,read_cart_transforms,read_locations,write_products,read_products,write_inventory,read_inventory,read_publications,write_publications").trim();
// Mutable — updated at runtime when OAuth completes
let SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const QUOTE_FUNCTION_ID = (process.env.QUOTE_FUNCTION_ID || "").trim();
const CART_TRANSFORM_FUNCTION_ID = (process.env.CART_TRANSFORM_FUNCTION_ID || "").trim();
const FAL_KEY = (process.env.FAL_KEY || "").trim();
if (FAL_KEY) fal.config({ credentials: FAL_KEY });
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const FIREBASE_API_KEY = (process.env.FIREBASE_API_KEY || "").trim();
const FIREBASE_AUTH_DOMAIN = (process.env.FIREBASE_AUTH_DOMAIN || "").trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();
const FIREBASE_STORAGE_BUCKET = (process.env.FIREBASE_STORAGE_BUCKET || "").trim();
const FIREBASE_MESSAGING_SENDER_ID = (process.env.FIREBASE_MESSAGING_SENDER_ID || "").trim();
const FIREBASE_APP_ID = (process.env.FIREBASE_APP_ID || "").trim();
const FIREBASE_MEASUREMENT_ID = (process.env.FIREBASE_MEASUREMENT_ID || "").trim();
const AI_RATE_LIMIT_MAX = Number(process.env.AI_RATE_LIMIT_MAX || 10);
const AI_RATE_LIMIT_WINDOW_MS = Number(process.env.AI_RATE_LIMIT_WINDOW_MS || 60_000);
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 12_000);
const AI_AWAIT_TIMEOUT_MS = Number(process.env.AI_AWAIT_TIMEOUT_MS || 45_000);
const AI_AWAIT_POLL_MS = Number(process.env.AI_AWAIT_POLL_MS || 1500);
const AI_STATUS_MIN_POLL_MS = Number(process.env.AI_STATUS_MIN_POLL_MS || 1500);
const AI_ALLOWED_MODELS = (process.env.AI_ALLOWED_MODELS || "flux,flux-pro,flux-schnell")
  .split(",").map(s => s.trim()).filter(Boolean);
const AI_NEGATIVE_PROMPT = (
  process.env.AI_NEGATIVE_PROMPT ||
  "photorealistic, photograph, 3d render, hyperrealistic, skin texture, bokeh, camera, lens, realistic lighting, blurry, watermark, ugly, deformed"
).trim();

const aiRequestMeta = new Map();
const aiRateLimitByIp = new Map();
const aiStatusCache = new Map();
const aiStatusLastPollByKey = new Map();

let pricingCache = null;

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
}

// ── Fal.ai model registry ─────────────────────────────────────────────────────
const FAL_MODEL_PATHS = {
  "flux":         "fal-ai/flux",
  "flux-pro":     "fal-ai/flux-pro",
  "flux-schnell": "fal-ai/flux/schnell",
  "flux-realism": "fal-ai/flux-realism",
  "recraft-v3":   "fal-ai/recraft-v3",
};

function buildFalModelPath(provider, model) {
  if (provider !== "fal.ai") {
    throw new Error("Unsupported provider. Only fal.ai is currently supported.");
  }
  if (!AI_ALLOWED_MODELS.includes(model)) {
    throw new Error(
      `Unsupported model "${model}". Allowed: ${AI_ALLOWED_MODELS.join(", ")}.`
    );
  }
  const path = FAL_MODEL_PATHS[model];
  if (!path) {
    throw new Error(`No fal.ai path configured for model "${model}".`);
  }
  return path;
}

function getFalHeaders() {
  if (!FAL_KEY) {
    throw new Error("Missing FAL_KEY environment variable.");
  }
  return {
    Authorization: `Key ${FAL_KEY}`,
    "Content-Type": "application/json"
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonSafely(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequesterKey(req) {
  return String(req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
}

function enforceAiRateLimit(req, res) {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const current = aiRateLimitByIp.get(ip) || { count: 0, windowStart: now };
  if (now - current.windowStart > AI_RATE_LIMIT_WINDOW_MS) {
    current.count = 0;
    current.windowStart = now;
  }
  current.count += 1;
  aiRateLimitByIp.set(ip, current);
  if (current.count > AI_RATE_LIMIT_MAX) {
    res.status(429).json({
      ok: false,
      message: "Rate limit exceeded. Please try again shortly."
    });
    return false;
  }
  return true;
}

const SHOP_DOMAIN = normalizeShopDomain(SHOPIFY_SHOP_DOMAIN);

function appendCheckoutParams(invoiceUrl) {
  if (!invoiceUrl) return invoiceUrl;
  const sep = invoiceUrl.includes("?") ? "&" : "?";
  return `${invoiceUrl}${sep}auto_redirect=false&edge_redirect=true&skip_shop_pay=true`;
}

async function getPricing() {
  if (!pricingCache) pricingCache = await loadPricing(PRICING_FILE);
  return pricingCache;
}

// ── Groq prompt rewriter ──────────────────────────────────────────────────────
// Dynamically rewrites any user prompt into proper patch-style art prompt.
// Works for ALL patch types: embroidered, PVC, woven, leather, chenille, etc.
// If no GROQ_API_KEY is set, falls back to a simple suffix append.
async function rewritePromptForPatch(userPrompt) {
  if (!GROQ_API_KEY) {
    return `patch design of ${userPrompt}, flat 2D graphic, bold simple shapes, hard border, isolated on white background, no depth`;
  }

  try {
    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 120,
          messages: [
            {
              role: "system",
              content: `You are a prompt rewriter for a patch design generator.
              Your ONLY job is to rewrite the user's prompt so the image looks like a real physical patch.
               
              You must detect which patch type the user mentions and apply the correct style rules below.
              If no patch type is mentioned, default to "embroidered patch".
               
              ━━━ PATCH TYPE STYLE RULES ━━━
               
              EMBROIDERED PATCH:
              - Stitched thread texture on fabric
              - Hard merrowed rolled border around the edge
              - Flat 2D design, bold simple shapes
              - Limited thread colors (4-8 colors max)
              - Prompt style: "embroidered patch, stitched thread texture, merrowed border, flat 2D bold shapes, limited thread colors, isolated on white background"
               
              PVC / RUBBER PATCH:
              - Molded rubber or silicone material
              - Raised slightly but still flat graphic design
              - Very bold clean shapes, hard edges
              - Used on tactical gear, bags, jackets
              - Prompt style: "PVC rubber patch, molded silicone material, bold clean shapes, hard edges, slightly raised surface, tactical badge style, isolated on white background"
               
              CHENILLE PATCH:
              - Thick fuzzy looped yarn texture, feels like velvet
              - Very bold chunky shapes, no fine detail possible
              - 2-3 solid block colors max
              - Felt or twill backing
              - Varsity letterman jacket style
              - Prompt style: "chenille varsity patch, thick fuzzy looped yarn texture, bold chunky shapes, felt backing, solid block colors, fluffy raised surface, isolated on white background"
               
              WOVEN PATCH:
              - Tightly woven fabric, like a label
              - Very fine detail possible, almost photographic
              - Thinner and flatter than embroidered
              - Soft texture, used on clothing labels and hats
              - Prompt style: "woven fabric patch, tightly woven label texture, fine detail, flat thin profile, soft fabric texture, clean border, isolated on white background"
               
              LEATHER PATCH:
              - Natural or synthetic leather material
              - Debossed or engraved design (pressed into leather)
              - Usually 1-2 tones, raw or colored leather
              - Used on jeans, bags, jackets, boots
              - Prompt style: "leather patch, debossed engraved design, natural leather texture, earthy tones, clean die-cut edge, isolated on white background"
               
              BULLION / WIRE PATCH:
              - Handmade with real gold or silver metallic wire
              - Very luxurious, military or formal style
              - Raised 3D texture from coiled metallic threads
              - Rich gold/silver tones on dark backgrounds
              - Used on military uniforms, blazers, caps
              - Prompt style: "bullion wire patch, gold metallic coiled thread texture, raised 3D embroidery, military formal style, rich gold tones, dark backing, isolated on white background"
               
              PRINTED / SUBLIMATED PATCH:
              - Full color photographic print on fabric
              - Unlimited colors, gradients allowed
              - Flat surface, no texture
              - Clean cut or shaped border
              - Prompt style: "sublimated printed patch, full color print on fabric, flat surface, clean shaped border, vibrant colors, isolated on white background"
               
              FELT PATCH:
              - Soft flat felt fabric
              - Simple flat shapes, no texture detail
              - Bold solid colors, clean edges
              - Craft or vintage style
              - Prompt style: "felt patch, soft flat felt fabric, simple bold shapes, solid colors, clean cut edge, vintage craft style, isolated on white background"
               
              ━━━ RULES ━━━
              - ALWAYS start the output with the patch type (e.g. "Embroidered patch of...", "PVC patch of...", "Chenille patch of...")
              - Keep the subject 100% as the user intended — NEVER drop or replace the main subject (if user says "a woman drinking coffee", the woman must be in the rewrite, not just the coffee cup)
              - Detect and preserve the patch type if user mentions it; if no type mentioned, default to embroidered patch
              - If the user mentions specific text or a name to appear on the patch, preserve it exactly in the rewrite
              - If the user mentions a specific shape (circle, shield, rectangle, hexagon), preserve it; if NO shape mentioned, default to circular patch shape
              - If the user mentions a background color, preserve it
              - If the input contains multiple subjects on separate lines, summarize them into ONE single unified patch design — do not list separately, create one cohesive concept
              - Apply the matching style rules from above for the detected patch type
              - Always end with: isolated on plain white background, no scenery, no backdrop
              - Strip out any words like: realistic, cinematic, photo, painting, render, atmospheric
              - Return ONLY the rewritten prompt as a single sentence, nothing else, no explanation`
            },
            {
              role: "user",
              content: userPrompt
            }
          ]
        })
      },
      8000
    );

    const data = await readJsonSafely(response);

    if (!response.ok) {
      const errMsg = data?.error?.message || data?.message || `HTTP ${response.status}`;
      console.warn(`[GROQ] API error: ${errMsg} — using fallback`);
      return `Embroidered circular patch of ${userPrompt}, stitched thread texture, merrowed border, flat 2D bold shapes, limited thread colors, isolated on plain white background, no scenery`;
    }

    const rewritten = data?.choices?.[0]?.message?.content?.trim();

    if (!rewritten) {
      return `Embroidered circular patch of ${userPrompt}, stitched thread texture, merrowed border, flat 2D bold shapes, limited thread colors, isolated on plain white background, no scenery`;
    }

    return rewritten;
  } catch (error) {
    console.warn(`[GROQ] Prompt rewrite failed: ${error?.message || "unknown error"} — using fallback`);
    return `Embroidered circular patch of ${userPrompt}, stitched thread texture, merrowed border, flat 2D bold shapes, limited thread colors, isolated on plain white background, no scenery`;
  }
}

async function shopifyAdminGraphql(query, variables = {}) {
  if (!SHOP_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("Missing Shopify env vars. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.");
  }

  const response = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    throw new Error(`Shopify GraphQL returned non-JSON response (status ${response.status}).`);
  }
  if (!response.ok) {
    const errMessage =
      data?.errors?.[0]?.message ||
      data?.error ||
      data?.message ||
      raw ||
      `Shopify GraphQL request failed with status ${response.status}.`;
    throw new Error(`Shopify GraphQL request failed with status ${response.status}: ${String(errMessage).slice(0, 300)}`);
  }

  if (data.errors?.length) {
    throw new Error(data.errors[0].message || "Shopify GraphQL returned errors.");
  }

  return data.data;
}

async function getQuoteFunctionId() {
  if (QUOTE_FUNCTION_ID) {
    return { functionId: QUOTE_FUNCTION_ID, functions: [], source: "env" };
  }

  const query = `
    query AppFunctions {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `;
  const data = await shopifyAdminGraphql(query);
  const functions = data?.shopifyFunctions?.nodes || [];
  const byTitle = functions.find((item) => {
    const title = (item?.title || "").toLowerCase();
    return (
      title.includes("quote-pricing-function") ||
      title.includes("quote pricing function") ||
      title.includes("quote pricing")
    );
  });

  if (byTitle?.id) return { functionId: byTitle.id, functions, source: "title" };

  const byType = functions.find((item) => {
    const apiType = (item?.apiType || "").toLowerCase();
    return apiType.includes("discount");
  });

  if (byType?.id) return { functionId: byType.id, functions, source: "apiType" };

  return { functionId: null, functions, source: "none" };
}

async function getCartTransformFunctionId() {
  if (CART_TRANSFORM_FUNCTION_ID) {
    return { functionId: CART_TRANSFORM_FUNCTION_ID, functions: [], source: "env" };
  }

  const query = `
    query AppFunctions {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `;
  const data = await shopifyAdminGraphql(query);
  const functions = data?.shopifyFunctions?.nodes || [];
  const byTitle = functions.find((item) => {
    const title = (item?.title || "").toLowerCase();
    return title.includes("cart-transformer") || title.includes("cart transformer");
  });

  if (byTitle?.id) return { functionId: byTitle.id, functions, source: "title" };

  const byType = functions.find((item) => {
    const apiType = (item?.apiType || "").toLowerCase();
    return apiType.includes("cart_transform");
  });

  if (byType?.id) return { functionId: byType.id, functions, source: "apiType" };

  return { functionId: null, functions, source: "none" };
}

function discountEndsAt(days = 3650) {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toISOString();
}

async function findExistingQuoteAutomaticDiscount() {
  const listQuery = `
    query ExistingDiscounts($query: String!) {
      discountNodes(first: 25, query: $query) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp {
              title
              status
            }
          }
        }
      }
    }
  `;
  const existingData = await shopifyAdminGraphql(listQuery, { query: "title:'Quote Pricing Auto'" });
  return (existingData?.discountNodes?.nodes || []).find((node) => {
    const discount = node?.discount;
    return discount?.__typename === "DiscountAutomaticApp" && discount?.title === "Quote Pricing Auto";
  });
}

async function createQuoteAutomaticDiscount(functionId) {
  const mutation = `
    mutation DiscountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
          appDiscountType {
            functionId
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    automaticAppDiscount: {
      title: "Quote Pricing Auto",
      functionId,
      discountClasses: ["ORDER", "PRODUCT", "SHIPPING"],
      startsAt: new Date().toISOString(),
      endsAt: discountEndsAt(),
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: true,
        shippingDiscounts: true
      }
    }
  };

  const createData = await shopifyAdminGraphql(mutation, variables);
  const result = createData?.discountAutomaticAppCreate;
  const userErrors = result?.userErrors || [];
  return { result, userErrors };
}

async function findExistingCartTransform(functionId) {
  const listQuery = `
    query ExistingCartTransforms {
      cartTransforms(first: 25) {
        nodes {
          id
          functionId
        }
      }
    }
  `;
  const existingData = await shopifyAdminGraphql(listQuery);
  const nodes = existingData?.cartTransforms?.nodes || [];
  if (!functionId) return nodes[0] || null;
  return nodes.find((node) => node?.functionId === functionId) || null;
}

// ── Shopify OAuth ─────────────────────────────────────────────────────────────
const oauthNonces = new Set();

app.get("/shopify/auth", (req, res) => {
  const shop = normalizeShopDomain(String(req.query.shop || SHOPIFY_SHOP_DOMAIN));
  if (!shop) return res.status(400).send("Missing shop parameter.");
  if (!SHOPIFY_API_KEY) return res.status(500).send("SHOPIFY_API_KEY is not configured.");

  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  oauthNonces.add(nonce);

  const redirectUri = `${APP_URL}/shopify/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${encodeURIComponent(SHOPIFY_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;
  res.redirect(authUrl);
});

app.get("/shopify/callback", async (req, res) => {
  const { shop, code, state, hmac, ...rest } = req.query;

  if (!shop || !code) return res.status(400).send("Missing shop or code.");

  // Validate nonce to prevent CSRF
  if (!oauthNonces.has(state)) {
    return res.status(403).send("Invalid state parameter. Possible CSRF attack.");
  }
  oauthNonces.delete(state);

  // Verify HMAC signature from Shopify
  if (hmac && SHOPIFY_API_SECRET) {
    const crypto = await import("crypto");
    const message = Object.entries({ shop, code, state, ...rest })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
    if (digest !== hmac) return res.status(403).send("HMAC validation failed.");
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(400).send("Failed to get access token: " + JSON.stringify(tokenData));
    }

    // Update the in-memory token so all subsequent API calls use it
    SHOPIFY_ADMIN_ACCESS_TOKEN = tokenData.access_token;

    console.log(`[OAUTH] Token obtained for shop: ${shop} — set SHOPIFY_ADMIN_ACCESS_TOKEN in your env to persist it.`);

    res.type("html").send(`
      <!doctype html><html><head><meta charset="UTF-8"/>
      <style>body{font-family:Arial,sans-serif;max-width:600px;margin:60px auto;padding:24px}
      code{background:#f4f4f4;padding:4px 8px;border-radius:4px;word-break:break-all;display:block;margin:8px 0}
      .btn{display:inline-block;margin-top:16px;padding:10px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none}</style>
      </head><body>
      <h2>✓ OAuth successful</h2>
      <p>Access token obtained for <strong>${shop}</strong>.</p>
      <p>Save this token as <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code> in your Vercel environment variables to persist it across deployments:</p>
      <code>${tokenData.access_token}</code>
      <p>Granted scopes: <code>${tokenData.scope}</code></p>
      <a class="btn" href="/">Go to admin panel</a>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("OAuth error: " + (err?.message || String(err)));
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    quoteSecretConfigured: QUOTE_SECRET !== "dev-secret",
    pricingFile: PRICING_FILE
  });
});

app.get("/", (_req, res) => {
  const firebaseConfig = JSON.stringify({
    apiKey: FIREBASE_API_KEY,
    authDomain: FIREBASE_AUTH_DOMAIN,
    projectId: FIREBASE_PROJECT_ID,
    storageBucket: FIREBASE_STORAGE_BUCKET,
    messagingSenderId: FIREBASE_MESSAGING_SENDER_ID,
    appId: FIREBASE_APP_ID,
    measurementId: FIREBASE_MEASUREMENT_ID,
  });

  res.type("html").send(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Patches Setup</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        min-height: 100vh;
        background: #f5f5f5;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1.5;
      }

      /* ── Auth card ── */
      #auth-section {
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 12px;
        padding: 36px 40px;
        width: 100%;
        max-width: 400px;
        box-shadow: 0 2px 12px rgba(0,0,0,.08);
      }
      #auth-section h1 { margin: 0 0 6px; font-size: 22px; }
      #auth-section p.sub { margin: 0 0 24px; color: #666; font-size: 14px; }
      .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
      .field label { font-size: 13px; font-weight: 600; color: #333; }
      .field input {
        padding: 9px 12px;
        border: 1px solid #ccc;
        border-radius: 8px;
        font-size: 14px;
        outline: none;
        transition: border-color .15s;
      }
      .field input:focus { border-color: #555; }
      #auth-submit {
        width: 100%;
        padding: 10px;
        background: #111;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 15px;
        cursor: pointer;
        margin-top: 4px;
        transition: background .15s;
      }
      #auth-submit:hover { background: #333; }
      #auth-submit:disabled { background: #999; cursor: default; }
      #auth-error { color: #c0392b; font-size: 13px; margin-top: 10px; min-height: 18px; }

      /* ── Admin panel ── */
      #admin-section {
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 12px;
        padding: 32px 36px;
        width: 100%;
        max-width: 700px;
        box-shadow: 0 2px 12px rgba(0,0,0,.08);
      }
      #admin-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      #admin-header h1 { margin: 0; font-size: 22px; }
      #logout-btn {
        padding: 6px 14px;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        color: #333;
      }
      #logout-btn:hover { background: #f5f5f5; }
      #user-email { font-size: 13px; color: #666; margin-bottom: 20px; }

      /* ── Shopify buttons ── */
      .btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .btn-row button {
        padding: 9px 14px;
        border: 1px solid #444;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        background: #fff;
      }
      .btn-row button:hover { background: #f0f0f0; }
      pre {
        background: #111;
        color: #e8e8e8;
        padding: 14px;
        border-radius: 8px;
        overflow: auto;
        font-size: 13px;
        margin: 0 0 24px;
      }

      /* ── Create user box ── */
      .section-title {
        font-size: 15px;
        font-weight: 700;
        margin: 0 0 12px;
        padding-top: 20px;
        border-top: 1px solid #eee;
      }
      #create-user-form {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: flex-end;
      }
      #create-user-form .field { margin: 0; flex: 1; min-width: 160px; }
      #create-user-btn {
        padding: 9px 18px;
        background: #111;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;
      }
      #create-user-btn:hover { background: #333; }
      #create-user-btn:disabled { background: #999; cursor: default; }
      #create-user-msg { font-size: 13px; margin-top: 10px; min-height: 18px; }
      #create-user-msg.ok  { color: #27ae60; }
      #create-user-msg.err { color: #c0392b; }

      .hidden { display: none !important; }
    </style>
  </head>
  <body>

    <!-- ── Login card ── -->
    <div id="auth-section">
      <h1>Sign in</h1>
      <p class="sub">Patches admin panel</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" placeholder="••••••••" autocomplete="current-password" />
      </div>
      <button id="auth-submit">Sign in</button>
      <div id="auth-error"></div>
    </div>

    <!-- ── Admin panel (hidden until logged in) ── -->
    <div id="admin-section" class="hidden">
      <div id="admin-header">
        <h1>Patches app</h1>
        <button id="logout-btn">Sign out</button>
      </div>
      <div id="user-email"></div>

      <div class="btn-row">
        <button id="ensure">Create/activate quote discount</button>
        <button id="disableQuoteDiscount">Disable quote discount</button>
        <button id="recreateQuoteDiscount">Recreate quote discount</button>
        <button id="ensureTransform">Create/activate cart transform</button>
        <button id="disableTransform">Disable cart transform</button>
      </div>
      <pre id="out">Ready.</pre>

      <!-- ── Create user ── -->
      <p class="section-title">Create a new user</p>
      <div id="create-user-form">
        <div class="field">
          <label for="new-email">Email</label>
          <input id="new-email" type="email" placeholder="newuser@example.com" autocomplete="off" />
        </div>
        <div class="field">
          <label for="new-password">Password</label>
          <input id="new-password" type="password" placeholder="Min 6 characters" autocomplete="new-password" />
        </div>
        <button id="create-user-btn">Create user</button>
      </div>
      <div id="create-user-msg"></div>
    </div>

    <!-- Firebase compat SDK (v10) -->
    <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>

    <script>
      // ── Firebase init ─────────────────────────────────────────────────────────
      const firebaseConfig = ${firebaseConfig};

      // Primary app — used for the admin's own session
      firebase.initializeApp(firebaseConfig);
      const auth = firebase.auth();

      // Secondary app — used to create new users without signing out the admin
      const secondaryApp = firebase.initializeApp(firebaseConfig, "secondary");
      const secondaryAuth = secondaryApp.auth();

      // ── UI refs ───────────────────────────────────────────────────────────────
      const authSection   = document.getElementById("auth-section");
      const adminSection  = document.getElementById("admin-section");
      const emailInput    = document.getElementById("email");
      const passInput     = document.getElementById("password");
      const submitBtn     = document.getElementById("auth-submit");
      const errorDiv      = document.getElementById("auth-error");
      const userEmailDiv  = document.getElementById("user-email");
      const out           = document.getElementById("out");
      const newEmailInput = document.getElementById("new-email");
      const newPassInput  = document.getElementById("new-password");
      const createBtn     = document.getElementById("create-user-btn");
      const createMsg     = document.getElementById("create-user-msg");

      // ── Login ─────────────────────────────────────────────────────────────────
      submitBtn.addEventListener("click", async () => {
        const email    = emailInput.value.trim();
        const password = passInput.value;
        errorDiv.textContent = "";
        if (!email || !password) { errorDiv.textContent = "Please enter your email and password."; return; }

        submitBtn.disabled = true;
        submitBtn.textContent = "Signing in…";
        try {
          await auth.signInWithEmailAndPassword(email, password);
        } catch (err) {
          errorDiv.textContent = friendlyError(err.code);
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in";
        }
      });

      [emailInput, passInput].forEach(el =>
        el.addEventListener("keydown", e => { if (e.key === "Enter") submitBtn.click(); })
      );

      // ── Auth state ────────────────────────────────────────────────────────────
      auth.onAuthStateChanged(user => {
        if (user) {
          authSection.classList.add("hidden");
          adminSection.classList.remove("hidden");
          userEmailDiv.textContent = "Signed in as " + user.email;
        } else {
          authSection.classList.remove("hidden");
          adminSection.classList.add("hidden");
          emailInput.value = "";
          passInput.value  = "";
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in";
        }
      });

      // ── Logout ────────────────────────────────────────────────────────────────
      document.getElementById("logout-btn").addEventListener("click", () => auth.signOut());

      // ── Create user (secondary app keeps admin signed in) ─────────────────────
      createBtn.addEventListener("click", async () => {
        const email    = newEmailInput.value.trim();
        const password = newPassInput.value;
        createMsg.className = "";
        createMsg.textContent = "";

        if (!email || !password) { createMsg.className = "err"; createMsg.textContent = "Email and password are required."; return; }
        if (password.length < 6) { createMsg.className = "err"; createMsg.textContent = "Password must be at least 6 characters."; return; }

        createBtn.disabled = true;
        createBtn.textContent = "Creating…";
        try {
          await secondaryAuth.createUserWithEmailAndPassword(email, password);
          await secondaryAuth.signOut();
          createMsg.className = "ok";
          createMsg.textContent = "User " + email + " created successfully.";
          newEmailInput.value = "";
          newPassInput.value  = "";
        } catch (err) {
          createMsg.className = "err";
          createMsg.textContent = friendlyError(err.code);
        } finally {
          createBtn.disabled = false;
          createBtn.textContent = "Create user";
        }
      });

      // ── Shopify admin buttons ─────────────────────────────────────────────────
      async function callApi(url, label) {
        out.textContent = label + "…";
        try {
          const res  = await fetch(url, { method: "POST" });
          const data = await res.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          out.textContent = "Request failed: " + (err.message || String(err));
        }
      }

      document.getElementById("ensure").addEventListener("click",
        () => callApi("/api/shopify/discounts/quote/ensure", "Creating discount"));
      document.getElementById("disableQuoteDiscount").addEventListener("click",
        () => callApi("/api/shopify/discounts/quote/disable", "Disabling quote discount"));
      document.getElementById("recreateQuoteDiscount").addEventListener("click",
        () => callApi("/api/shopify/discounts/quote/recreate", "Recreating quote discount"));
      document.getElementById("ensureTransform").addEventListener("click",
        () => callApi("/api/shopify/cart-transform/ensure", "Creating cart transform"));
      document.getElementById("disableTransform").addEventListener("click",
        () => callApi("/api/shopify/cart-transform/disable", "Disabling cart transform"));

      // ── Friendly error messages ───────────────────────────────────────────────
      function friendlyError(code) {
        const map = {
          "auth/invalid-email":          "Invalid email address.",
          "auth/user-not-found":         "No account found with this email.",
          "auth/wrong-password":         "Incorrect password.",
          "auth/invalid-credential":     "Incorrect email or password.",
          "auth/email-already-in-use":   "An account with this email already exists.",
          "auth/weak-password":          "Password must be at least 6 characters.",
          "auth/too-many-requests":      "Too many attempts. Please try again later.",
          "auth/network-request-failed": "Network error. Check your connection.",
        };
        return map[code] || "Something went wrong. Please try again.";
      }
    </script>
  </body>
</html>
  `);
});

app.get("/api/shopify/check", async (_req, res) => {
  if (!SHOP_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return res.status(400).json({
      ok: false,
      message: "Missing Shopify env vars. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN."
    });
  }
  try {
    const response = await fetch(
      `https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        ok: false,
        message: "Shopify API check failed.",
        details: text
      });
    }
    const data = await response.json();
    return res.json({
      ok: true,
      shop: data?.shop?.domain || SHOP_DOMAIN
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Shopify connectivity check failed."
    });
  }
});

app.get("/api/shopify/functions", async (_req, res) => {
  try {
    const query = `
      query AppFunctions {
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `;
    const data = await shopifyAdminGraphql(query);
    return res.json({
      ok: true,
      functions: data?.shopifyFunctions?.nodes || []
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to load Shopify Functions."
    });
  }
});

// ── GET /api/ai/models ────────────────────────────────────────────────────────
// Returns the list of models the frontend is allowed to use.
app.get("/api/ai/models", (_req, res) => {
  res.json({
    ok: true,
    provider: "fal.ai",
    models: AI_ALLOWED_MODELS
  });
});

// ── POST /api/ai/generate ─────────────────────────────────────────────────────
app.post("/api/ai/generate", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;

  try {
    const {
      prompt = "",
      provider = "fal.ai",
      model = "flux",
      productHandle = ""
    } = req.body || {};

    // Normalize the prompt — collapse blank lines, trim each line.
    // Groq handles multiple subjects by summarizing them into one patch concept.
    const userPrompt = String(prompt || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");

    if (!userPrompt) {
      return res.status(400).json({ ok: false, message: "prompt is required." });
    }
    if (userPrompt.length < 3 || userPrompt.length > 300) {
      return res.status(400).json({
        ok: false,
        message: "prompt must be between 3 and 300 characters."
      });
    }

    // If the user didn't mention any patch type, tag it as embroidered so Groq
    // always has a type to apply the correct style rules against.
    const PATCH_TYPE_KEYWORDS = ["embroidered", "pvc", "rubber", "chenille", "woven", "leather", "bullion", "wire", "printed", "sublimated", "felt"];
    const promptLower = userPrompt.toLowerCase();
    const hasPatchType = PATCH_TYPE_KEYWORDS.some((kw) => promptLower.includes(kw));
    const promptForGroq = hasPatchType ? userPrompt : `embroidered patch: ${userPrompt}`;

    // Groq rewrites into full patch-style language with correct type rules applied.
    // We only prepend visual style constraints — never override the patch type itself.
    const patchPrompt = await rewritePromptForPatch(promptForGroq);
    const finalPrompt = `2D flat vector patch design, sticker art style, no 3D, no depth, no clay, hard outer border, isolated on pure white background: ${patchPrompt}`;
    console.log(`[AI_GENERATE] original="${userPrompt}" groqInput="${promptForGroq}" rewritten="${patchPrompt}"`);
    console.log(`[AI_GENERATE] finalPrompt="${finalPrompt}"`);

    const modelPath = buildFalModelPath(provider, model);
    const response = await fetchWithTimeout(
      `https://queue.fal.run/${modelPath}`,
      {
        method: "POST",
        headers: getFalHeaders(),
        body: JSON.stringify({
          prompt: finalPrompt,
          negative_prompt: AI_NEGATIVE_PROMPT,
          num_inference_steps: 35,
          guidance_scale: 9.0,
          image_size: "square"
        })
      }
    );

    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      payload = {};
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        message: payload?.error || payload?.message || "fal.ai generate request failed."
      });
    }

    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) {
      return res.status(502).json({
        ok: false,
        message: "fal.ai did not return requestId."
      });
    }

    aiRequestMeta.set(requestId, { provider, model });

    const shop = req.headers["x-shopify-shop-domain"] || SHOP_DOMAIN || "unknown-shop";
    console.log(`[AI_GENERATE] requestId=${requestId} shop=${shop} promptLen=${userPrompt.length}`);

    const compositeId = Buffer.from(JSON.stringify({ modelPath: FAL_MODEL_PATHS[model], id: requestId })).toString("base64url");
    return res.json({
      requestId: compositeId,
      status: "processing"
    });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      message: isTimeout ? "AI generation request timed out." : (error?.message || "Failed to start AI generation.")
    });
  }
});

// ── Shared fal.ai status poller ──────────────────────────────────────────────
async function pollFalStatus(compositeRequestId, res) {
  const requestId = String(compositeRequestId || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, message: "requestId is required." });

  let falRequestId = requestId;
  let modelPath = "fal-ai/flux";
  try {
    const decoded = JSON.parse(Buffer.from(requestId, "base64url").toString());
    if (decoded.modelPath && decoded.id) {
      modelPath = decoded.modelPath;
      falRequestId = decoded.id;
    }
  } catch (_) {}

  const falBase = `https://queue.fal.run/${modelPath}/requests/${encodeURIComponent(falRequestId)}`;
  const statusResponse = await fetchWithTimeout(`${falBase}/status`, { method: "GET", headers: getFalHeaders() });
  const statusPayload = await readJsonSafely(statusResponse);

  if (!statusResponse.ok) {
    return res.status(502).json({
      status: "failed",
      error: statusPayload?.detail || statusPayload?.error || statusPayload?.message || `fal.ai status check failed (${statusResponse.status}).`
    });
  }

  const falStatus = String(statusPayload?.status || "").toUpperCase();

  if (falStatus === "COMPLETED") {
    const resultResponse = await fetchWithTimeout(falBase, { method: "GET", headers: getFalHeaders() });
    const resultPayload = await readJsonSafely(resultResponse);
    if (!resultResponse.ok) {
      return res.status(502).json({
        status: "failed",
        error: resultPayload?.detail || resultPayload?.error || resultPayload?.message || "fal.ai result fetch failed."
      });
    }
    const images = resultPayload?.image?.url
      ? [{ url: resultPayload.image.url }]
      : (resultPayload?.images || []).map((item) => ({ url: item?.url })).filter((item) => Boolean(item.url));
    return res.json({ status: "completed", images });
  }

  if (falStatus === "FAILED" || falStatus === "ERROR") {
    return res.json({
      status: "failed",
      error: statusPayload?.error || statusPayload?.detail || statusPayload?.message || "Job failed."
    });
  }

  return res.json({ status: "processing", falStatus });
}

// ── GET /api/ai/generate/:requestId ──────────────────────────────────────────
app.get("/api/ai/generate/:requestId", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    return await pollFalStatus(req.params.requestId, res);
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({ status: "failed", error: isTimeout ? "Timed out." : (error?.message || "Status check failed.") });
  }
});

// ── GET /api/ai/edit/:requestId ───────────────────────────────────────────────
app.get("/api/ai/edit/:requestId", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;

  const compositeId = String(req.params.requestId || "").trim();
  if (!compositeId) return res.status(400).json({ ok: false, message: "requestId is required." });

  if (!FAL_KEY) return res.status(500).json({ ok: false, message: "FAL_KEY is not configured." });

  let model, falRequestId;
  try {
    const decoded = JSON.parse(Buffer.from(compositeId, "base64url").toString());
    model = decoded.model || decoded.modelPath;
    falRequestId = decoded.id;
    if (!model || !falRequestId) throw new Error("missing fields");
  } catch (_) {
    return res.status(400).json({ ok: false, message: "Invalid or malformed requestId." });
  }

  try {
    const statusResult = await fal.queue.status(model, { requestId: falRequestId, logs: false });

    if (statusResult.status === "COMPLETED") {
      const resultData = await fal.queue.result(model, { requestId: falRequestId });
      const output = resultData.data || {};
      const images = output.images ?? (output.image ? [output.image] : []);
      return res.json({
        status: "completed",
        images: images.map((img) => ({
          url: img.url,
          width: img.width,
          height: img.height,
          content_type: img.content_type,
        })),
      });
    }

    if (statusResult.status === "FAILED") {
      return res.json({ status: "failed", error: "Job failed on fal.ai." });
    }

    return res.json({ status: "processing" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Status check failed";
    if (message.toLowerCase().includes("failed") || message.toLowerCase().includes("cancelled")) {
      return res.json({ status: "failed", error: message });
    }
    return res.status(500).json({ ok: false, message });
  }
});

app.post("/api/shopify/discounts/quote/ensure", async (_req, res) => {
  try {
    const { functionId, functions, source } = await getQuoteFunctionId();
    if (!functionId) {
      return res.status(404).json({
        ok: false,
        message: "Could not auto-detect quote function ID from Shopify Functions.",
        hint: "Set QUOTE_FUNCTION_ID in .env, or call GET /api/shopify/functions and copy the correct id.",
        candidates: functions.map((item) => ({
          id: item?.id,
          title: item?.title,
          apiType: item?.apiType
        }))
      });
    }

    const existingNode = await findExistingQuoteAutomaticDiscount();

    if (existingNode) {
      return res.json({
        ok: true,
        created: false,
        message: "Quote automatic discount already exists.",
        functionSource: source,
        functionId,
        discountNodeId: existingNode.id
      });
    }

    const { result, userErrors } = await createQuoteAutomaticDiscount(functionId);
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: "Shopify returned user errors while creating automatic discount.",
        userErrors,
        functionId
      });
    }

    return res.json({
      ok: true,
      created: true,
      functionSource: source,
      functionId,
      automaticAppDiscount: result?.automaticAppDiscount
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to ensure quote automatic discount."
    });
  }
});

app.post("/api/shopify/discounts/quote/disable", async (_req, res) => {
  try {
    const existingNode = await findExistingQuoteAutomaticDiscount();
    if (!existingNode?.id) {
      return res.json({
        ok: true,
        disabled: false,
        message: "No existing quote automatic discount found."
      });
    }

    const deleteMutation = `
      mutation DiscountAutomaticDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors {
            field
            message
          }
        }
      }
    `;
    const deleteData = await shopifyAdminGraphql(deleteMutation, { id: existingNode.id });
    const deleteResult = deleteData?.discountAutomaticDelete;
    const deleteErrors = deleteResult?.userErrors || [];
    if (deleteErrors.length) {
      return res.status(400).json({
        ok: false,
        message: "Failed to disable existing quote automatic discount.",
        userErrors: deleteErrors,
        discountNodeId: existingNode.id
      });
    }

    return res.json({
      ok: true,
      disabled: true,
      deletedAutomaticDiscountId: deleteResult?.deletedAutomaticDiscountId || existingNode.id
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to disable quote automatic discount."
    });
  }
});

app.post("/api/shopify/discounts/quote/recreate", async (_req, res) => {
  try {
    const { functionId, functions, source } = await getQuoteFunctionId();
    if (!functionId) {
      return res.status(404).json({
        ok: false,
        message: "Could not auto-detect quote function ID from Shopify Functions.",
        hint: "Set QUOTE_FUNCTION_ID in .env, or call GET /api/shopify/functions and copy the correct id.",
        candidates: functions.map((item) => ({
          id: item?.id,
          title: item?.title,
          apiType: item?.apiType
        }))
      });
    }

    const existingNode = await findExistingQuoteAutomaticDiscount();
    let deletedAutomaticDiscountId = null;

    if (existingNode?.id) {
      const deleteMutation = `
        mutation DiscountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors {
              field
              message
            }
          }
        }
      `;
      const deleteData = await shopifyAdminGraphql(deleteMutation, { id: existingNode.id });
      const deleteResult = deleteData?.discountAutomaticDelete;
      const deleteErrors = deleteResult?.userErrors || [];
      if (deleteErrors.length) {
        return res.status(400).json({
          ok: false,
          message: "Failed to disable existing quote automatic discount.",
          userErrors: deleteErrors,
          discountNodeId: existingNode.id
        });
      }
      deletedAutomaticDiscountId = deleteResult?.deletedAutomaticDiscountId || existingNode.id;
    }

    const { result, userErrors } = await createQuoteAutomaticDiscount(functionId);
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: "Existing discount was disabled, but creating replacement failed.",
        userErrors,
        functionId,
        deletedAutomaticDiscountId
      });
    }

    return res.json({
      ok: true,
      recreated: true,
      functionSource: source,
      functionId,
      deletedAutomaticDiscountId,
      automaticAppDiscount: result?.automaticAppDiscount
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to recreate quote automatic discount."
    });
  }
});

app.post("/api/shopify/cart-transform/ensure", async (_req, res) => {
  try {
    const { functionId, functions, source } = await getCartTransformFunctionId();
    if (!functionId) {
      return res.status(404).json({
        ok: false,
        message: "Could not auto-detect cart transform function ID from Shopify Functions.",
        hint: "Set CART_TRANSFORM_FUNCTION_ID in .env, or call GET /api/shopify/functions and copy the correct id.",
        candidates: functions.map((item) => ({
          id: item?.id,
          title: item?.title,
          apiType: item?.apiType
        }))
      });
    }

    const existingNode = await findExistingCartTransform(functionId);

    if (existingNode) {
      return res.json({
        ok: true,
        created: false,
        message: "Cart transform already exists.",
        functionSource: source,
        functionId,
        cartTransformId: existingNode.id
      });
    }

    const createMutation = `
      mutation CartTransformCreate($functionId: String!, $blockOnFailure: Boolean!) {
        cartTransformCreate(functionId: $functionId, blockOnFailure: $blockOnFailure) {
          cartTransform {
            id
            functionId
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const createData = await shopifyAdminGraphql(createMutation, {
      functionId,
      blockOnFailure: false
    });
    const result = createData?.cartTransformCreate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: "Shopify returned user errors while creating cart transform.",
        userErrors,
        functionId
      });
    }

    return res.json({
      ok: true,
      created: true,
      functionSource: source,
      functionId,
      cartTransform: result?.cartTransform
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to ensure cart transform."
    });
  }
});

app.post("/api/shopify/cart-transform/disable", async (_req, res) => {
  try {
    const { functionId } = await getCartTransformFunctionId();
    const existingNode = await findExistingCartTransform(functionId || null);
    if (!existingNode?.id) {
      return res.json({
        ok: true,
        disabled: false,
        message: "No existing cart transform found."
      });
    }

    const mutation = `
      mutation CartTransformDelete($id: ID!) {
        cartTransformDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await shopifyAdminGraphql(mutation, { id: existingNode.id });
    const result = data?.cartTransformDelete;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: "Shopify returned user errors while disabling cart transform.",
        userErrors,
        cartTransformId: existingNode.id
      });
    }

    return res.json({
      ok: true,
      disabled: true,
      deletedCartTransformId: result?.deletedId || existingNode.id
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to disable cart transform."
    });
  }
});

app.post("/api/quote", async (req, res) => {
  try {
    const {
      productName = "",
      width = 2,
      height = 2.19,
      qty = 10,
      options = {}
    } = req.body || {};

    const parsedQty = Math.max(10, Number(qty) || 10);
    const parsedHeight = Math.max(1, Number(height) || 1);
    const parsedWidth = Math.max(1, Number(width) || 1);

    const pricingRows = await getPricing();
    const matchedRows = matchRows(pricingRows, productName);
    const quote = quoteFromRows(matchedRows, {
      height: parsedHeight,
      qty: parsedQty
    });

    if (!quote) {
      return res.status(404).json({
        ok: false,
        message: "No pricing found for this product/size/qty."
      });
    }

    const payload = {
      productName,
      width: parsedWidth,
      height: parsedHeight,
      qty: parsedQty,
      unitPrice: Number(quote.unitPrice.toFixed(2)),
      total: Number(quote.total.toFixed(2)),
      sizeUsed: quote.sizeUsed,
      tierQty: quote.tierQty,
      ts: Date.now(),
      options
    };

    const quoteToken = signQuote(payload, QUOTE_SECRET);

    return res.json({
      ok: true,
      unitPrice: payload.unitPrice,
      calculatedUnitPrice: payload.unitPrice,
      total: payload.total,
      custom_price: payload.unitPrice.toFixed(2),
      cartLineProperties: {
        custom_price: payload.unitPrice.toFixed(2),
        quote_token: quoteToken,
        quote_qty: String(payload.qty),
        quote_height: String(payload.height),
        quote_width: String(payload.width)
      },
      tier: {
        minQty: quote.tierQty,
        label: quote.tierRange
      },
      quoteToken
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || "Unknown quote error"
    });
  }
});

// ── POST /api/ai/remove-background ──────────────────────────────────────────
app.post("/api/ai/remove-background", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ ok: false, message: "image_url is required." });

    const response = await fetchWithTimeout(
      "https://queue.fal.run/fal-ai/birefnet",
      {
        method: "POST",
        headers: getFalHeaders(),
        body: JSON.stringify({ image_url })
      },
      AI_TIMEOUT_MS
    );
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: payload?.error || payload?.message || "fal.ai birefnet request failed." });
    }
    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) return res.status(502).json({ ok: false, message: "fal.ai did not return requestId." });
    aiRequestMeta.set(requestId, { provider: "fal.ai", model: "birefnet", modelPath: "fal-ai/birefnet" });
    const compositeIdBg = Buffer.from(JSON.stringify({ modelPath: "fal-ai/birefnet", id: requestId })).toString("base64url");
    return res.json({ requestId: compositeIdBg, status: "processing" });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({ ok: false, message: isTimeout ? "Request timed out." : (error?.message || "Failed to start background removal.") });
  }
});

// ── POST /api/ai/crop ─────────────────────────────────────────────────────────
app.post("/api/ai/crop", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ ok: false, message: "image_url is required." });

    const cropPrompt = "Tightly crop the image so the patch artwork fills the entire frame with minimal whitespace around the edges. Keep the patch design intact, do not alter or modify the artwork.";
    const response = await fetchWithTimeout(
      "https://queue.fal.run/fal-ai/flux-pro/kontext/max",
      {
        method: "POST",
        headers: getFalHeaders(),
        body: JSON.stringify({ prompt: cropPrompt, image_url })
      },
      AI_TIMEOUT_MS
    );
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: payload?.error || payload?.message || "fal.ai crop request failed." });
    }
    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) return res.status(502).json({ ok: false, message: "fal.ai did not return requestId." });
    aiRequestMeta.set(requestId, { provider: "fal.ai", model: "flux-pro-kontext-max", modelPath: "fal-ai/flux-pro/kontext/max" });
    const compositeIdCrop = Buffer.from(JSON.stringify({ modelPath: "fal-ai/flux-pro/kontext/max", id: requestId })).toString("base64url");
    return res.json({ requestId: compositeIdCrop, status: "processing" });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({ ok: false, message: isTimeout ? "Request timed out." : (error?.message || "Failed to start crop.") });
  }
});

// ── AI edit helpers ───────────────────────────────────────────────────────────
const EDIT_MODEL_BY_ACTION = {
  remove_background: "fal-ai/birefnet",
  crop: "fal-ai/flux-pro/kontext/max",
  edit: "fal-ai/flux-pro/kontext/max",
};

const EDIT_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function resolveEditImageUrl(imageUrl) {
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }
  if (!imageUrl.startsWith("/")) {
    throw new Error("Invalid image path: must be an absolute URL or a path starting with /");
  }
  if (!FAL_KEY) throw new Error("Missing FAL_KEY environment variable.");

  const safePath = path.normalize(imageUrl).replace(/^(\.\.(\/|\\|$))+/, "");
  const absolutePath = path.join(process.cwd(), "public", safePath);
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeType = EDIT_MIME_BY_EXT[ext] ?? "application/octet-stream";
  const bytes = await readFile(absolutePath);

  const fileBlob = new Blob([bytes], { type: mimeType });
  return fal.storage.upload(fileBlob);
}

function buildEditActionInput(action, imageUrl, prompt) {
  if (action === "remove_background") {
    return { image_url: imageUrl };
  }
  if (action === "crop") {
    return {
      image_url: imageUrl,
      prompt:
        "Tightly crop around the main embroidered patch artwork. Keep the full patch visible including its original background. Do not remove or change the background color. Just crop tightly around the patch edges.",
    };
  }
  return {
    image_url: imageUrl,
    prompt:
      String(prompt || "").trim() ||
      "Refine this patch design while preserving the same subject, text, and colors.",
  };
}

// ── POST /api/ai/edit ─────────────────────────────────────────────────────────
app.post("/api/ai/edit", async (req, res) => {
  if (!enforceAiRateLimit(req, res)) return;
  try {
    const { action, imageUrl, prompt } = req.body || {};

    if (!action || !EDIT_MODEL_BY_ACTION[action]) {
      return res.status(400).json({ ok: false, message: "action must be one of remove_background, crop, edit" });
    }
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({ ok: false, message: "imageUrl is required" });
    }
    if (action === "edit" && (!prompt || !String(prompt).trim())) {
      return res.status(400).json({ ok: false, message: "prompt is required for edit action" });
    }

    const resolvedImageUrl = await resolveEditImageUrl(imageUrl);
    const model = EDIT_MODEL_BY_ACTION[action];
    const input = buildEditActionInput(action, resolvedImageUrl, prompt);

    const queueResult = await Promise.race([
      fal.queue.submit(model, { input }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Fal queue submit timed out")), AI_TIMEOUT_MS)
      ),
    ]);

    const compositeIdEdit = Buffer.from(JSON.stringify({ model, id: queueResult.request_id })).toString("base64url");
    return res.json({ requestId: compositeIdEdit, status: "processing" });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({ ok: false, message: isTimeout ? "Request timed out." : (error?.message || "Failed to start edit.") });
  }
});

// ── POST /api/forms/submit ────────────────────────────────────────────────────
// Proxy route to submit form data to outjackets.com
app.post("/api/forms/submit", async (req, res) => {
  const FORM_API_URL = "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public";

  const requiredFields = [
    "email",
    "phoneNumber",
    "queryFrom",
    "patchType",
    "shape",
    "backing",
    "border",
    "thread",
    "colors",
    "size",
    "quantity",
    "unitPrice",
    "subTotal",
  ];

  try {
    // Validate required fields
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        ok: false,
        message: `Missing required fields: ${missingFields.join(", ")}`
      });
    }

    // Forward the request to the external API
    const response = await fetch(FORM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // Return the response from the external API
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        message: data?.message || "Failed to submit form",
        error: data
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Form submitted successfully",
      data
    });
  } catch (error) {
    console.error("Form submission error:", error);
    return res.status(500).json({
      ok: false,
      message: "Internal server error while submitting form",
      error: error?.message
    });
  }
});

// ── POST /api/upload — Shopify CDN via staged uploads ────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    const allowed = [
      "image/jpeg", "image/jpg", "image/png", "image/gif",
      "image/webp", "image/svg+xml", "application/pdf",
      "application/illustrator", "application/postscript",
      "image/ai", "image/eps",
    ];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("File type not supported. Please upload an image (JPEG, PNG, GIF, WebP, SVG) or document (PDF, AI, EPS)"));
  },
});

function buildStoredFileName(originalName) {
  const lastDot = originalName.lastIndexOf(".");
  const hasExt  = lastDot > 0;
  const base     = hasExt ? originalName.slice(0, lastDot) : originalName;
  const ext      = hasExt ? originalName.slice(lastDot).toLowerCase() : "";
  const safeName = base.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "upload";
  const suffix   = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${safeName}-${suffix}${ext}`;
}

app.options("/api/upload", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  }).sendStatus(200);
});

app.get("/api/upload", (_req, res) => {
  res.json({ message: "File upload endpoint — Shopify CDN" });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const { originalname, mimetype, size, buffer } = req.file;
    const fileName   = buildStoredFileName(originalname);
    const resource   = mimetype.startsWith("image/") ? "IMAGE" : "FILE";

    // ── Step 1: Ask Shopify for a pre-signed upload URL ───────────────────────
    const stagedData = await shopifyAdminGraphql(
      `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
      {
        input: [{
          filename:   fileName,
          mimeType:   mimetype,
          resource,
          fileSize:   String(size),
          httpMethod: "PUT",
        }],
      }
    );

    const stageErrors = stagedData.stagedUploadsCreate.userErrors;
    if (stageErrors.length) {
      return res.status(400).json({ error: stageErrors[0].message });
    }

    const target = stagedData.stagedUploadsCreate.stagedTargets[0];

    // ── Step 2: PUT the file bytes to the pre-signed URL ─────────────────────
    const uploadRes = await fetch(target.url, {
      method:  "PUT",
      headers: { "Content-Type": mimetype, "Content-Length": String(size) },
      body:    buffer,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      return res.status(502).json({ error: `Shopify staged upload failed (${uploadRes.status})`, detail: text });
    }

    // ── Step 3: Register the file in Shopify Files so it gets a CDN URL ──────
    const fileData = await shopifyAdminGraphql(
      `mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            ... on MediaImage  { image { url } }
            ... on GenericFile { url }
          }
          userErrors { field message }
        }
      }`,
      {
        files: [{
          contentType:    resource,
          originalSource: target.resourceUrl,
          filename:       fileName,
        }],
      }
    );

    const fileErrors = fileData.fileCreate.userErrors;
    if (fileErrors.length) {
      return res.status(400).json({ error: fileErrors[0].message });
    }

    const createdFile = fileData.fileCreate.files[0];
    const cdnUrl      = createdFile?.image?.url ?? createdFile?.url ?? target.resourceUrl;

    return res.json({
      success:     true,
      url:         cdnUrl,
      resourceUrl: target.resourceUrl,
      fileName:    originalname,
      fileSize:    size,
      fileType:    mimetype,
    });

  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to upload file" });
  }
});

// ── POST /api/shopify/draft-orders ───────────────────────────────────────────
// Creates a Shopify draft order via the GraphQL draftOrderCreate mutation.
// Body: { input: DraftOrderInput } — pass the full input object as per Shopify docs.
app.post("/api/shopify/draft-orders", async (req, res) => {
  const { input } = req.body || {};
  if (!input || typeof input !== "object") {
    return res.status(400).json({ ok: false, message: "input object is required." });
  }

  try {
    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            status
            totalPrice
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const data = await shopifyAdminGraphql(mutation, { input });

    const result = data?.draftOrderCreate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: userErrors[0]?.message || "Shopify returned user errors.",
        userErrors
      });
    }

    return res.json({
      ok: true,
      draftOrder: result?.draftOrder
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to create draft order."
    });
  }
});

// Best-effort cleanup of hidden checkout products if a later step in the
// multi-item checkout flow fails partway through.
async function cleanupCheckoutProducts(productIds) {
  await Promise.all(productIds.map((id) =>
    shopifyAdminGraphql(`
      mutation DeleteCheckoutProduct($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          userErrors { field message }
        }
      }
    `, { input: { id } }).catch((err) => {
      console.error("[CHECKOUT] Cleanup error:", err.message);
    })
  ));
}

// Creates a hidden (DRAFT-priced) Shopify product + variant for a single
// checkout line item. Throws an Error with .statusCode/.userErrors on failure.
async function createCheckoutProductForItem(item) {
  const {
    productName = "",
    quantity,
    unitPrice: rawUnitPrice,
    imageUrl = "",
    width  = 2,
    height = 2.19,
    options = {}
  } = item || {};

  const qty          = Math.max(10, Number(quantity) || 10);
  const parsedHeight = Math.max(1, Number(height) || 1);
  const parsedWidth  = Math.max(1, Number(width)  || 1);

  const unitPrice = Number(Number(rawUnitPrice || 0).toFixed(2));
  if (!unitPrice || unitPrice <= 0) {
    const err = new Error("unitPrice is required and must be greater than 0 for every line item.");
    err.statusCode = 400;
    throw err;
  }
  const total = Number((unitPrice * qty).toFixed(2));

  const quotePayload = {
    productName, width: parsedWidth, height: parsedHeight,
    qty, unitPrice, total,
    ts: Date.now(), options
  };
  const quoteToken = signQuote(quotePayload, QUOTE_SECRET);

  const patchType  = options.patchType  || productName || "Custom Patch";
  const size       = options.size       || `${parsedWidth}" x ${parsedHeight}"`;
  const shape      = options.shape      || "";
  const backing    = options.backing    || "";
  const border     = options.border     || "";
  const colors     = options.colors     || "";

  const productTitle = `${patchType} — ${qty} pcs, ${size}${shape ? `, ${shape}` : ""}`;

  // Normalise imageUrl — protocol-relative CDN URLs (e.g. from Shopify's
  // `image_url` filter or cart.items[].image, which return "//cdn..." with
  // no protocol) just need "https:" prepended; other relative paths get the
  // store domain prepended.
  const resolvedImageUrl = imageUrl
    ? imageUrl.startsWith("http")
      ? imageUrl
      : imageUrl.startsWith("//")
        ? `https:${imageUrl}`
        : `https://${SHOP_DOMAIN}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`
    : "";

  const mediaInput = resolvedImageUrl
    ? [{ originalSource: resolvedImageUrl, alt: productTitle, mediaContentType: "IMAGE" }]
    : [];

  const productData = await shopifyAdminGraphql(`
    mutation CreateCheckoutProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          variants(first: 1) {
            nodes { id }
          }
        }
        userErrors { field message }
      }
    }
  `, {
    product: {
      title:  productTitle,
      status: "ACTIVE",
      tags:   ["custom-patch-checkout", `qty-${qty}`, patchType.toLowerCase().replace(/\s+/g, "-")],
      metafields: [
        { namespace: "custom", key: "seo_robots", value: "noindex, nofollow", type: "single_line_text_field" }
      ]
    },
    media: mediaInput
  });
  const productResult = productData?.productCreate;
  const productErrors = productResult?.userErrors || [];

  if (productErrors.length) {
    const err = new Error(productErrors[0]?.message || "Failed to create product.");
    err.statusCode = 400;
    err.userErrors = productErrors;
    throw err;
  }

  const createdProduct = productResult?.product;
  const createdVariant = createdProduct?.variants?.nodes?.[0];

  if (!createdVariant?.id) {
    const err = new Error("Product created but variant ID not returned.");
    err.statusCode       = 502;
    err.createdProductId = createdProduct?.id;
    throw err;
  }

  // Set exact price on the default variant
  const variantData = await shopifyAdminGraphql(`
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price sku }
        userErrors { field message }
      }
    }
  `, {
    productId: createdProduct.id,
    variants: [{
      id:    createdVariant.id,
      price: unitPrice.toFixed(2),
    }]
  });
  const variantErrors = variantData?.productVariantsBulkUpdate?.userErrors || [];

  if (variantErrors.length) {
    const err = new Error(variantErrors[0]?.message || "Failed to set variant price.");
    err.statusCode       = 400;
    err.userErrors       = variantErrors;
    err.createdProductId = createdProduct.id;
    throw err;
  }

  return {
    productId: createdProduct.id,
    variantId: createdVariant.id,
    qty, unitPrice, total, quoteToken, productTitle,
    customAttributes: [
      { key: "_quote_token", value: quoteToken },
      { key: "Patch Type",   value: patchType },
      { key: "Size",         value: size },
      ...(shape   ? [{ key: "Shape",   value: shape   }] : []),
      ...(backing ? [{ key: "Backing", value: backing }] : []),
      ...(border  ? [{ key: "Border",  value: border  }] : []),
      ...(colors  ? [{ key: "Colors",  value: colors  }] : []),
      { key: "Quantity",   value: String(qty) },
      { key: "Unit Price", value: `$${unitPrice.toFixed(2)}` },
    ]
  };
}

// ── POST /api/shopify/checkout ────────────────────────────────────────────────
// Creates one hidden (DRAFT-priced) Shopify product per line item with the
// exact quote price and patch configuration baked into the variant, then
// creates a single draft order across all of them and returns its invoice
// URL for immediate customer redirect to the normal Shopify checkout.
//
// Body (single product, backward compatible):
// {
//   productName:  "Embroidered Patch",   // for quote pricing lookup
//   quantity:     50,
//   width:        3,
//   height:       3,
//   options: {
//     patchType:    "Embroidered",
//     shape:        "Circle",
//     backing:      "Heat Applied",
//     backingPrice: 0.50,
//     border:       "Merrow",
//     colors:       "5"
//   }
// }
//
// Body (multiple products):
// {
//   lineItems: [
//     { productName: "...", quantity: 50, unitPrice: 4.5, width: 3, height: 3, options: {...} },
//     { productName: "...", quantity: 20, unitPrice: 6.0, width: 2, height: 2, options: {...} }
//   ]
// }
app.post("/api/shopify/checkout", async (req, res) => {
  const body = req.body || {};
  const rawItems = Array.isArray(body.lineItems) && body.lineItems.length > 0
    ? body.lineItems
    : [body];

  const createdProductIds = [];

  try {
    const builtItems = [];
    for (const rawItem of rawItems) {
      const item = await createCheckoutProductForItem(rawItem);
      createdProductIds.push(item.productId);
      builtItems.push(item);
    }

    // ── Create a single draft order across all line items ────────────────────
    // DRAFT products can't be added via cart permalink, but draft order invoiceUrl
    // works regardless of product status. Since variant price = custom quote price,
    // Shopify uses it directly — no discount override needed.
    const totalQty = builtItems.reduce((sum, i) => sum + i.qty, 0);

    const draftData = await shopifyAdminGraphql(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            totalPrice
            invoiceUrl
          }
          userErrors { field message }
        }
      }
    `, {
      input: {
        lineItems: builtItems.map((i) => ({
          variantId:        i.variantId,
          quantity:         i.qty,
          customAttributes: i.customAttributes,
        })),
        shippingLine: totalQty < 100
          ? { title: "Standard Shipping", price: "30.00" }
          : { title: "Free Shipping",     price: "0.00"  },
        note: builtItems.map((i) => i.productTitle).join(" + "),
      }
    });

    const draftErrors = draftData?.draftOrderCreate?.userErrors || [];
    if (draftErrors.length) {
      await cleanupCheckoutProducts(createdProductIds);
      return res.status(400).json({
        ok: false,
        message: draftErrors[0]?.message || "Failed to create draft order.",
        userErrors: draftErrors
      });
    }

    const draftOrder = draftData?.draftOrderCreate?.draftOrder;
    if (!draftOrder?.invoiceUrl) {
      await cleanupCheckoutProducts(createdProductIds);
      return res.status(502).json({
        ok: false,
        message: "Draft order created but invoiceUrl not returned.",
        draftOrder
      });
    }

    return res.json({
      ok: true,
      invoiceUrl: appendCheckoutParams(draftOrder.invoiceUrl),
      draftOrder: {
        id:         draftOrder.id,
        name:       draftOrder.name,
        totalPrice: draftOrder.totalPrice,
      },
      quotes: builtItems.map((i) => ({
        unitPrice:  i.unitPrice,
        total:      i.total,
        qty:        i.qty,
        quoteToken: i.quoteToken
      }))
    });

  } catch (error) {
    if (error?.createdProductId) createdProductIds.push(error.createdProductId);
    await cleanupCheckoutProducts(createdProductIds);
    return res.status(error?.statusCode || 500).json({
      ok: false,
      message: error?.message || "Failed to create checkout.",
      ...(error?.userErrors ? { userErrors: error.userErrors } : {})
    });
  }
});

// ── PUT /api/shopify/draft-orders/:draftOrderId ──────────────────────────────
// Updates an existing Shopify draft order via the GraphQL draftOrderUpdate mutation.
// draftOrderId can be a numeric ID or full GID. Body: { input: DraftOrderInput }
app.patch("/api/shopify/draft-orders/:draftOrderId", async (req, res) => {
  const { draftOrderId } = req.params;
  const { input } = req.body || {};

  if (!draftOrderId) {
    return res.status(400).json({ ok: false, message: "draftOrderId is required." });
  }
  if (!input || typeof input !== "object") {
    return res.status(400).json({ ok: false, message: "input object is required." });
  }

  const gid = draftOrderId.startsWith("gid://") ? draftOrderId : `gid://shopify/DraftOrder/${draftOrderId}`;

  // Coerce lineItems numeric fields so string values from clients don't break Shopify
  // Also default requiresShipping to true so shippingLine is accepted by Shopify
  if (Array.isArray(input.lineItems)) {
    input.lineItems = input.lineItems.map((item) => ({
      ...item,
      ...(item.quantity          != null && { quantity:          parseInt(item.quantity, 10) }),
      ...(item.originalUnitPrice != null && { originalUnitPrice: parseFloat(item.originalUnitPrice) }),
      requiresShipping: item.requiresShipping !== false,
    }));
  }


  console.log("[DRAFT_ORDER_UPDATE] input being sent to Shopify:", JSON.stringify(input, null, 2));

  try {
    const mutation = `
      mutation updateDraftOrder($input: DraftOrderInput!, $ownerId: ID!) {
        draftOrderUpdate(input: $input, id: $ownerId) {
          draftOrder {
            id
            name
            status
            totalPrice
            invoiceUrl
            updatedAt
            shippingLine {
              title
              discountedPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
            metafields(first: 10) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const data = await shopifyAdminGraphql(mutation, { ownerId: gid, input });

    const result = data?.draftOrderUpdate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: userErrors[0]?.message || "Shopify returned user errors.",
        userErrors
      });
    }

    const draftOrder = result?.draftOrder;
    const metafields = draftOrder?.metafields?.edges?.map(({ node }) => node) || [];

    return res.json({
      ok: true,
      draftOrder: {
        id:           draftOrder?.id,
        name:         draftOrder?.name,
        status:       draftOrder?.status,
        totalPrice:   draftOrder?.totalPrice,
        invoiceUrl:   appendCheckoutParams(draftOrder?.invoiceUrl),
        updatedAt:    draftOrder?.updatedAt,
        shippingLine: draftOrder?.shippingLine ?? null,
        metafields,
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to update draft order."
    });
  }
});

// ── POST /api/shopify/draft-orders/from-form ─────────────────────────────────
// Creates a Shopify draft order from the patch quote form submission payload.
app.post("/api/shopify/draft-orders/from-form", async (req, res) => {
  const {
    email,
    phoneNumber,
    patchType,
    shape,
    backing,
    border,
    thread,
    colors,
    size,
    quantity,
    unitPrice,
    subTotal,
    uploadedFiles,
    queryFrom,
    notes,
    customerName,
    firstCampaign,
    firstMedium,
    firstSource,
    isFine,
    lastCampaign,
    lastMedium,
    lastSource,
  } = req.body || {};

  const required = { email, patchType, quantity, unitPrice, subTotal };
  const missing = Object.entries(required).filter(([, v]) => v == null || v === "").map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ ok: false, message: `Missing required fields: ${missing.join(", ")}` });
  }

  const customAttributes = [
    shape        && { key: "Shape",          value: String(shape) },
    backing      && { key: "Backing",         value: String(backing) },
    border       && { key: "Border",          value: String(border) },
    colors       && { key: "Colors",          value: String(colors) },
    size         && { key: "Size",            value: String(size) },
    thread       && { key: "Thread / Notes",  value: String(thread) },
    phoneNumber  && { key: "Phone",           value: String(phoneNumber) },
    queryFrom    && { key: "Source URL",      value: String(queryFrom) },
    ...(Array.isArray(uploadedFiles) ? uploadedFiles.map((file, i) => ({ key: `Artwork File ${i + 1}`, value: String(file?.fileUrl ?? file) })) : []),
  ].filter(Boolean);

  const input = {
    email: String(email),
    note: [
      `Patch Type: ${patchType}`,
      size        ? `Size: ${size}`               : null,
      phoneNumber ? `Phone: ${phoneNumber}`        : null,
      thread      ? `Thread / Notes: ${thread}`    : null,
      queryFrom   ? `Source: ${queryFrom}`         : null,
    ].filter(Boolean).join("\n"),
    lineItems: [
      {
        title:             String(patchType),
        originalUnitPrice: parseFloat(unitPrice),
        quantity:          parseInt(quantity, 10),
        customAttributes,
      },
    ],
    customAttributes: [
      queryFrom && { key: "Source URL", value: String(queryFrom) },
    ].filter(Boolean),
  };

  try {
    console.log("[DRAFT_ORDER] final input:", JSON.stringify(input, null, 2));

    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            status
            totalPrice
            invoiceUrl
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const data = await shopifyAdminGraphql(mutation, { input });

    console.log("[DRAFT_ORDER] mutation response:", JSON.stringify(data, null, 2));
    const result = data?.draftOrderCreate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      console.error("[DRAFT_ORDER] userErrors:", userErrors);
      return res.status(400).json({
        ok: false,
        message: userErrors[0]?.message || "Shopify returned user errors.",
        userErrors
      });
    }

    const draftOrder = result?.draftOrder;

    // ── Forward to form submission API ────────────────────────────────────────
    const FORM_API_URL = "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d/forms/for-category/public";
    try {
      await fetch(FORM_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          phoneNumber,
          queryFrom,
          patchType,
          shape,
          backing,
          border,
          thread,
          colors,
          size,
          quantity,
          unitPrice,
          subTotal,
          uploadedFiles,
          notes,
          customerName,
          firstCampaign,
          firstMedium,
          firstSource,
          isFine,
          lastCampaign,
          lastMedium,
          lastSource,
          shopifyOrderId: draftOrder?.id,
          invoiceUrl:     draftOrder?.invoiceUrl,
          storeType:      "shopify",
        })
      });
    } catch (formErr) {
      console.error("[FORM_SUBMIT] Failed to forward to form API:", formErr?.message);
    }

    return res.json({
      ok: true,
      draftOrder: {
        ...draftOrder,
        invoiceUrl: appendCheckoutParams(draftOrder?.invoiceUrl),
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to create draft order."
    });
  }
});

// ── POST /api/shopify/draft-orders/manual ────────────────────────────────────
// Creates a DRAFT product from manual order fields, then creates a draft order.
// Body: { shipping, quantity, backing, broder, border, productImage, price?, email?, customerName? }
app.post("/api/shopify/draft-orders/manual", async (req, res) => {
  const {
    shipping,
    quantity,
    backing,
    broder,
    border,
    productImage,
    price,
    email,
    customerName,
  } = req.body || {};

  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) {
    return res.status(400).json({ ok: false, message: "quantity must be a positive integer." });
  }

  try {
    // ── Step 1: build product title + description ─────────────────────────────
    const borderValue  = border || broder || "";
    const productTitle = [
      "Manual Order",
      `Qty: ${qty}`,
      backing     ? `Backing: ${backing}`     : null,
      borderValue ? `Border: ${borderValue}`  : null,
    ].filter(Boolean).join(" | ");

    const descriptionLines = [
      `Quantity: ${qty}`,
      backing     ? `Backing: ${backing}`     : null,
      borderValue ? `Border: ${borderValue}`  : null,
      shipping    ? `Shipping: ${shipping}`   : null,
    ].filter(Boolean).join("\n");

    // ── Step 2: resolve image ─────────────────────────────────────────────────
    const resolvedImageUrl = productImage
      ? productImage.startsWith("http")
        ? productImage
        : `https://${SHOP_DOMAIN}${productImage.startsWith("/") ? "" : "/"}${productImage}`
      : null;

    const mediaInput = resolvedImageUrl
      ? [{ originalSource: resolvedImageUrl, alt: productTitle, mediaContentType: "IMAGE" }]
      : [];

    // ── Step 3: create DRAFT product ─────────────────────────────────────────
    const productData = await shopifyAdminGraphql(`
      mutation CreateManualProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message }
        }
      }
    `, {
      product: {
        title:       productTitle,
        descriptionHtml: descriptionLines.replace(/\n/g, "<br>"),
        status:      "ACTIVE",
        tags:        ["manual-order", `qty-${qty}`],
        metafields: [
          { namespace: "custom", key: "seo_robots", value: "noindex, nofollow", type: "single_line_text_field" }
        ]
      },
      media: mediaInput,
    });

    const productErrors = productData?.productCreate?.userErrors || [];
    if (productErrors.length) {
      return res.status(400).json({
        ok: false,
        message: productErrors[0]?.message || "Failed to create product.",
        userErrors: productErrors,
      });
    }

    const createdProduct = productData?.productCreate?.product;
    const createdVariant = createdProduct?.variants?.nodes?.[0];
    if (!createdVariant?.id) {
      return res.status(502).json({ ok: false, message: "Product created but variant ID not returned." });
    }

    // ── Step 4: set variant price (use provided price or default to 0.00) ─────
    const unitPrice = parseFloat(price) || 0;
    const variantData = await shopifyAdminGraphql(`
      mutation SetVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }
    `, {
      productId: createdProduct.id,
      variants:  [{ id: createdVariant.id, price: unitPrice.toFixed(2) }],
    });

    const variantErrors = variantData?.productVariantsBulkUpdate?.userErrors || [];
    if (variantErrors.length) {
      return res.status(400).json({
        ok: false,
        message: variantErrors[0]?.message || "Failed to set variant price.",
        userErrors: variantErrors,
      });
    }

    // ── Step 5: build shipping line ───────────────────────────────────────────
    const shippingLine = {
      title: "Shipping",
      price: shipping != null ? String(shipping) : "0.00",
    };

    // ── Step 6: create draft order ────────────────────────────────────────────
    const draftData = await shopifyAdminGraphql(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            status
            totalPrice
            invoiceUrl
          }
          userErrors { field message }
        }
      }
    `, {
      input: {
        lineItems: [{
          variantId: createdVariant.id,
          quantity:  qty,
          customAttributes: [
            { key: "Quantity",   value: String(qty) },
            backing     ? { key: "Backing", value: backing }       : null,
            borderValue ? { key: "Border",  value: borderValue }   : null,
          ].filter(Boolean),
        }],
        shippingLine,
        note: productTitle,
        ...(email && { email }),
        ...(customerName && {
          shippingAddress: { firstName: customerName },
          billingAddress:  { firstName: customerName },
        }),
      },
    });

    const draftErrors = draftData?.draftOrderCreate?.userErrors || [];
    if (draftErrors.length) {
      return res.status(400).json({
        ok: false,
        message: draftErrors[0]?.message || "Failed to create draft order.",
        userErrors: draftErrors,
      });
    }

    const draftOrder = draftData?.draftOrderCreate?.draftOrder;
    return res.json({
      ok:         true,
      productId:  createdProduct.id,
      draftOrder: {
        id:         draftOrder?.id,
        name:       draftOrder?.name,
        status:     draftOrder?.status,
        totalPrice: draftOrder?.totalPrice,
        invoiceUrl: appendCheckoutParams(draftOrder?.invoiceUrl),
      },
    });

  } catch (error) {
    console.error("[MANUAL_DRAFT_ORDER]", error?.message);
    return res.status(500).json({
      ok:      false,
      message: error?.message || "Failed to create manual draft order.",
    });
  }
});

// ── POST /api/shopify/orders/:orderId/send-invoice ───────────────────────────
// Sends an invoice email for a Shopify draft order via draftOrderInvoiceSend mutation.
// orderId can be a numeric ID or full GID (gid://shopify/DraftOrder/123).
app.post("/api/shopify/orders/:orderId/send-invoice", async (req, res) => {
  const { orderId } = req.params;
  const { customMessage, to } = req.body || {};

  if (!orderId) {
    return res.status(400).json({ ok: false, message: "orderId is required." });
  }


  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/DraftOrder/${orderId}`;

  try {
    const mutation = `
      mutation draftOrderInvoiceSend($id: ID!, $email: EmailInput) {
        draftOrderInvoiceSend(id: $id, email: $email) {
          draftOrder {
            id
          }
          userErrors {
            message
          }
        }
      }
    `;

    const variables = {
      id: gid,
      email: {
        ...(to && { to: String(to) }),
        ...(customMessage && { customMessage: String(customMessage) }),
      },
    };

    const data = await shopifyAdminGraphql(mutation, variables);

    const result = data?.draftOrderInvoiceSend;
    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        message: userErrors[0]?.message || "Shopify returned user errors.",
        userErrors
      });
    }

    return res.json({
      ok: true,
      draftOrderId: result?.draftOrder?.id || gid
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to send draft order invoice."
    });
  }
});

// ── GET /api/pricing/by-page-title ───────────────────────────────────────────
// Fetches and transforms pricing data from the external API by page title
app.get("/api/pricing/by-page-title", async (req, res) => {
  const title = req.query.title;

  if (!title) {
    return res.status(400).json({ error: "Title parameter is required" });
  }

  try {
    const API_BASE_URL = "https://outjackets.com/api/b79df6da-543e-48eb-a4d1-04ed0abbb97d";
    const response = await fetch(
      `${API_BASE_URL}/pricing/by-page-title?title=${encodeURIComponent(title)}`
    );

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch pricing data" });
    }

    const backendData = await response.json();

    const sizeGroups = {};
    backendData.forEach((item) => {
      if (item.pricingTables) {
        item.pricingTables.forEach((pricing) => {
          const sizeKey = `${pricing.size}"`;
          if (!sizeGroups[sizeKey]) {
            sizeGroups[sizeKey] = {
              size: sizeKey,
              qty10: "0", qty20: "0", qty25: "0", qty50: "0",
              qty75: "0", qty100: "0", qty200: "0", qty250: "0",
              qty300: "0", qty500: "0", qty700: "0", qty750: "0",
              qty1000: "0", qty1500: "0", qty2000: "0",
              qty5000: "0", qty10000: "0",
            };
          }
          sizeGroups[sizeKey][`qty${pricing.quantity}`] = pricing.price;
        });
      }
    });

    return res.json(Object.values(sizeGroups));
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Product helpers ───────────────────────────────────────────────────────────
let cachedProductPublicationInputs = null;
let cachedProductLocationId = null;

async function getProductPublicationInputs() {
  if (cachedProductPublicationInputs) return cachedProductPublicationInputs;
  const data = await shopifyAdminGraphql(`
    query { publications(first: 50) { nodes { id } } }
  `);
  cachedProductPublicationInputs = data.publications.nodes.map((n) => ({ publicationId: n.id }));
  return cachedProductPublicationInputs;
}

async function getProductLocationId() {
  if (cachedProductLocationId) return cachedProductLocationId;
  const data = await shopifyAdminGraphql(`
    query { locations(first: 1) { nodes { id name } } }
  `);
  cachedProductLocationId = data.locations.nodes[0]?.id ?? null;
  return cachedProductLocationId;
}

// ── POST /api/shopify/products ────────────────────────────────────────────────
// Body: { title, templateSuffix, variants: [{ price }], images: [{ url, altText }] }
app.post("/api/shopify/products", async (req, res) => {
  const {
    title,
    templateSuffix = "invoice",
    vendor,
    productType,
    tags,
    options,
    variants,
    images,
    quantity = 100,
    backing,
    shape,
    background,
    border,
    color,
    product_quantity,
    shipping,
  } = req.body || {};

  if (!title) {
    return res.status(400).json({ ok: false, message: "title is required" });
  }

  // Step 1: Create product + attach media in one mutation
  const mediaInput = Array.isArray(images) && images.length > 0
    ? images.map((img) => ({
        originalSource: img.url,
        alt: img.altText ?? title,
        mediaContentType: "IMAGE",
      }))
    : [];

  const customMetafields = [
    backing    && { namespace: "custom", key: "backing",    value: String(backing),    type: "single_line_text_field" },
    shape      && { namespace: "custom", key: "shape",      value: String(shape),      type: "single_line_text_field" },
    background && { namespace: "custom", key: "background", value: String(background), type: "single_line_text_field" },
    border            && { namespace: "custom", key: "border",            value: String(border),            type: "single_line_text_field" },
    color             && { namespace: "custom", key: "color",             value: String(color),             type: "single_line_text_field" },
    product_quantity  && { namespace: "custom", key: "product_quantity",  value: String(parseInt(product_quantity, 10)),  type: "number_integer" },
    shipping          && { namespace: "custom", key: "shipping",          value: String(parseInt(shipping, 10)),          type: "number_integer" },
    { namespace: "custom", key: "seo_robots", value: "noindex, nofollow", type: "single_line_text_field" },
  ].filter(Boolean);

  const productInput = {
    title,
    status: "ACTIVE",
    ...(templateSuffix          && { templateSuffix }),
    ...(vendor                  && { vendor }),
    ...(productType             && { productType }),
    ...(tags                    && { tags }),
    ...(options                 && { productOptions: options }),
    ...(customMetafields.length && { metafields: customMetafields }),
  };

  let createdProduct;
  try {
    const data = await shopifyAdminGraphql(`
      mutation CreateProductWithMedia($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id title handle status templateSuffix vendor productType tags onlineStoreUrl createdAt
            options {
              id name position
              optionValues { id name hasVariants }
            }
            variants(first: 10) {
              nodes {
                id
                inventoryItem { id tracked }
              }
            }
          }
          userErrors { field message }
        }
      }
    `, { product: productInput, media: mediaInput });

    if (data.productCreate.userErrors.length > 0) {
      return res.status(422).json({ ok: false, message: "Product creation failed", detail: data.productCreate.userErrors });
    }

    createdProduct = data.productCreate.product;
  } catch (err) {
    console.error("Product creation error:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to create product", detail: err.message });
  }

  // Step 2: Update default variant price
  let updatedVariants = [];
  if (Array.isArray(variants) && variants.length > 0) {
    const defaultVariantId = createdProduct.variants?.nodes?.[0]?.id;

    const variantsInput = variants.map((v, i) => ({
      ...(i === 0 && defaultVariantId ? { id: defaultVariantId } : {}),
      price: String(v.price ?? "0.00"),
      ...(v.compareAtPrice && { compareAtPrice: String(v.compareAtPrice) }),
      ...(v.sku            && { sku: v.sku }),
      inventoryItem: { tracked: true },
    }));

    try {
      const data = await shopifyAdminGraphql(`
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id title price compareAtPrice sku inventoryQuantity
              selectedOptions { name value }
            }
            userErrors { field message }
          }
        }
      `, { productId: createdProduct.id, variants: variantsInput });

      if (data.productVariantsBulkUpdate.userErrors.length > 0) {
        return res.status(422).json({ ok: false, message: "Variant update failed", detail: data.productVariantsBulkUpdate.userErrors, product: createdProduct });
      }

      updatedVariants = data.productVariantsBulkUpdate.productVariants;
    } catch (err) {
      console.error("Variant update error:", err.message);
      return res.status(500).json({ ok: false, message: "Product created but variant update failed", detail: err.message });
    }
  }

  // Step 3: Set inventory to 10 units
  const inventoryItemId = createdProduct.variants?.nodes?.[0]?.inventoryItem?.id;
  const locationId = await getProductLocationId();

  if (inventoryItemId && locationId) {
    try {
      const invData = await shopifyAdminGraphql(`
        mutation SetVariantInventory($inventoryItemId: ID!, $locationId: ID!, $quantity: Int!, $idempotencyKey: String!) {
          inventorySetQuantities(
            input: {
              name: "available"
              reason: "correction"
              referenceDocumentUri: "gid://your-app/InitialStock/1"
              quantities: [{
                inventoryItemId: $inventoryItemId
                locationId: $locationId
                quantity: $quantity
                changeFromQuantity: null
              }]
            }
          ) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id reason changes { name delta quantityAfterChange } }
            userErrors { code field message }
          }
        }
      `, {
        inventoryItemId,
        locationId,
        quantity: parseInt(quantity, 10),
        idempotencyKey: `set-inventory-${inventoryItemId}-${Date.now()}`,
      });

      if (invData.inventorySetQuantities.userErrors?.length > 0) {
        console.warn("Inventory set warnings:", invData.inventorySetQuantities.userErrors);
      }
    } catch (err) {
      console.error("Inventory set error:", err.message);
    }
  }

  // Step 4: Publish to all channels
  let onlineStoreUrl = createdProduct.onlineStoreUrl ?? null;
  try {
    const publicationInputs = await getProductPublicationInputs();
    if (publicationInputs.length > 0) {
      const pubData = await shopifyAdminGraphql(`
        mutation PublishProductToAllPublications($productId: ID!, $inputs: [PublicationInput!]!) {
          publishablePublish(id: $productId, input: $inputs) {
            publishable {
              ... on Product { id onlineStoreUrl }
            }
            userErrors { field message }
          }
        }
      `, { productId: createdProduct.id, inputs: publicationInputs });

      const published = pubData.publishablePublish;
      if (published.userErrors?.length > 0) {
        console.warn("Publish warnings:", published.userErrors);
      } else {
        onlineStoreUrl = published.publishable?.onlineStoreUrl ?? onlineStoreUrl;
      }
    }
  } catch (err) {
    console.error("Publish error:", err.message);
  }

  const { variants: _v, ...productData } = createdProduct;
  return res.status(201).json({
    ok: true,
    product: { ...productData, onlineStoreUrl },
    variants: updatedVariants,
  });
});

// ── DELETE /api/shopify/products/:id ─────────────────────────────────────────
app.delete("/api/shopify/products/:id", async (req, res) => {
  const id = req.params.id.startsWith("gid://")
    ? req.params.id
    : `gid://shopify/Product/${req.params.id}`;

  try {
    const data = await shopifyAdminGraphql(`
      mutation productDelete($id: ID!) {
        productDelete(input: { id: $id }) {
          deletedProductId
          userErrors { field message }
        }
      }
    `, { id });

    if (data.productDelete.userErrors.length > 0) {
      return res.status(422).json({ ok: false, message: "Failed to delete product", detail: data.productDelete.userErrors });
    }

    return res.json({ ok: true, deletedProductId: data.productDelete.deletedProductId });
  } catch (err) {
    console.error("Product delete error:", err.message);
    return res.status(500).json({ ok: false, message: "Failed to delete product", detail: err.message });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      ok: false,
      message: "Invalid JSON body. Please send valid JSON with Content-Type: application/json."
    });
  }
  return next(error);
});

app.listen(PORT, () => {
  console.log(`Quote API running on http://localhost:${PORT}`);
});