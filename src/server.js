import "dotenv/config";
import express from "express";
import cors from "cors";
import { loadPricing, matchRows, quoteFromRows } from "./pricing.js";
import { signQuote } from "./token.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    }
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

let pricingCache = null;

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
}

const SHOP_DOMAIN = normalizeShopDomain(SHOPIFY_SHOP_DOMAIN);

async function getPricing() {
  if (!pricingCache) pricingCache = await loadPricing(PRICING_FILE);
  return pricingCache;
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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Quote API running on http://localhost:${PORT}`);
});
