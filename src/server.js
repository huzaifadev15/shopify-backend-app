import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFile } from "fs/promises";
import path from "path";
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
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const QUOTE_FUNCTION_ID = (process.env.QUOTE_FUNCTION_ID || "").trim();
const CART_TRANSFORM_FUNCTION_ID = (process.env.CART_TRANSFORM_FUNCTION_ID || "").trim();
const FAL_KEY = (process.env.FAL_KEY || "").trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    quoteSecretConfigured: QUOTE_SECRET !== "dev-secret",
    pricingFile: PRICING_FILE
  });
});

app.get("/", (_req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Patches Setup</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; line-height: 1.4; }
      code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
      button { padding: 10px 14px; border: 1px solid #444; border-radius: 8px; cursor: pointer; }
      pre { background: #111; color: #e8e8e8; padding: 12px; border-radius: 8px; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>Patches app is running</h1>
    <p>This page is shown because Shopify redirects here while opening the app discount flow.</p>
    <p>Use the buttons below to activate app functions.</p>
    <button id="ensure">Create/activate quote discount</button>
    <button id="disableQuoteDiscount" style="margin-left: 8px;">Disable existing quote discount</button>
    <button id="recreateQuoteDiscount" style="margin-left: 8px;">Recreate quote discount</button>
    <button id="ensureTransform" style="margin-left: 8px;">Create/activate cart transform</button>
    <button id="disableTransform" style="margin-left: 8px;">Disable cart transform</button>
    <pre id="out">Ready.</pre>
    <script>
      const out = document.getElementById("out");
      document.getElementById("ensure").addEventListener("click", async () => {
        out.textContent = "Creating discount...";
        try {
          const response = await fetch("/api/shopify/discounts/quote/ensure", { method: "POST" });
          const data = await response.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          out.textContent = "Request failed: " + (error.message || String(error));
        }
      });
      document.getElementById("disableQuoteDiscount").addEventListener("click", async () => {
        out.textContent = "Disabling existing quote discount...";
        try {
          const response = await fetch("/api/shopify/discounts/quote/disable", { method: "POST" });
          const data = await response.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          out.textContent = "Request failed: " + (error.message || String(error));
        }
      });
      document.getElementById("recreateQuoteDiscount").addEventListener("click", async () => {
        out.textContent = "Recreating quote discount...";
        try {
          const response = await fetch("/api/shopify/discounts/quote/recreate", { method: "POST" });
          const data = await response.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          out.textContent = "Request failed: " + (error.message || String(error));
        }
      });
      document.getElementById("ensureTransform").addEventListener("click", async () => {
        out.textContent = "Creating cart transform...";
        try {
          const response = await fetch("/api/shopify/cart-transform/ensure", { method: "POST" });
          const data = await response.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          out.textContent = "Request failed: " + (error.message || String(error));
        }
      });
      document.getElementById("disableTransform").addEventListener("click", async () => {
        out.textContent = "Disabling cart transform...";
        try {
          const response = await fetch("/api/shopify/cart-transform/disable", { method: "POST" });
          const data = await response.json();
          out.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          out.textContent = "Request failed: " + (error.message || String(error));
        }
      });
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
  try {
    return await pollFalStatus(req.params.requestId, res);
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({ status: "failed", error: isTimeout ? "Timed out." : (error?.message || "Status check failed.") });
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

  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType }), path.basename(absolutePath));

  const uploadResponse = await fetchWithTimeout(
    "https://storage.fal.run",
    { method: "POST", headers: { Authorization: `Key ${FAL_KEY}` }, body: formData },
    AI_TIMEOUT_MS
  );
  if (!uploadResponse.ok) {
    const uploadErr = await readJsonSafely(uploadResponse);
    throw new Error(uploadErr?.error || uploadErr?.message || `fal storage upload failed (${uploadResponse.status})`);
  }
  const uploadData = await readJsonSafely(uploadResponse);
  if (!uploadData?.url) throw new Error("fal storage upload did not return a URL.");
  return uploadData.url;
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
    const modelPath = EDIT_MODEL_BY_ACTION[action];
    const input = buildEditActionInput(action, resolvedImageUrl, prompt);

    const response = await fetchWithTimeout(
      `https://queue.fal.run/${modelPath}`,
      { method: "POST", headers: getFalHeaders(), body: JSON.stringify(input) },
      AI_TIMEOUT_MS
    );
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      return res.status(502).json({ ok: false, message: payload?.error || payload?.message || "fal.ai edit request failed." });
    }
    const requestId = payload?.request_id || payload?.requestId;
    if (!requestId) return res.status(502).json({ ok: false, message: "fal.ai did not return requestId." });

    aiRequestMeta.set(requestId, { provider: "fal.ai", model: action, modelPath });
    const compositeIdEdit = Buffer.from(JSON.stringify({ modelPath, id: requestId })).toString("base64url");
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