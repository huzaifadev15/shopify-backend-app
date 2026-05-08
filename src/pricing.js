import pricingData from "../data/pricing.json" with { type: "json" };
import basePricingData from "../data/pricing-test.json" with { type: "json" };

export async function loadPricing(_relativePath) {
  return pricingData;
}

const DISCOUNT_TIERS = [
  { min: 1000, discount: 0.86 },
  { min: 500, discount: 0.83 },
  { min: 200, discount: 0.8 },
  { min: 100, discount: 0.75 },
  { min: 50, discount: 0.63 },
  { min: 25, discount: 0.38 },
  { min: 10, discount: 0 },
];

function getDiscount(qty) {
  for (const tier of DISCOUNT_TIERS) {
    if (qty >= tier.min) return tier.discount;
  }
  return null;
}

function getTierLabel(qty) {
  const tiers = [10, 25, 50, 100, 200, 500, 1000];
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (qty >= tiers[i]) {
      const next = tiers[i + 1];
      return {
        minQty: tiers[i],
        label: next ? `${tiers[i]}-${next - 1}` : `${tiers[i]}+`,
      };
    }
  }
  return { minQty: qty, label: `${qty}+` };
}

function quoteFromBasePrices(productName, size, qty) {
  const normName = normalize(productName);
  const entry = basePricingData.find(
    (r) => normalize(r.name) === normName && r.size === size,
  );
  if (!entry) return null;

  const discount = getDiscount(qty);
  if (discount === null) return null;

  const base = parseFloat(entry.basePrice);
  const unitPrice = parseFloat((base * (1 - discount)).toFixed(2));
  const total = parseFloat((unitPrice * qty).toFixed(2));
  const { minQty, label } = getTierLabel(qty);

  return {
    sizeUsed: size,
    tierQty: minQty,
    tierRange: label,
    unitPrice,
    total,
  };
}

function normalize(name) {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchRows(rows, productName) {
  const aliases = [
    "3D Embroidered patch",
    "3D Embroidered",
    "Embroidered & 3D Embroidered",
    productName,
  ].filter(Boolean);

  for (const alias of aliases) {
    const exact = rows.filter((r) => normalize(r.name) === normalize(alias));
    if (exact.length) return exact;
  }

  return rows.filter(
    (r) =>
      normalize(r.name).includes(normalize("3D Embroidered")) ||
      normalize(r.name).includes(normalize(productName)),
  );
}

export function quoteFromRows(rows, { height, qty }) {
  const valid = rows.filter(
    (r) =>
      typeof r.size === "number" &&
      typeof r.quantity === "number" &&
      !Number.isNaN(parseFloat(r.price)),
  );
  if (!valid.length) return null;

  const sizes = [...new Set(valid.map((r) => r.size))];
  let closest = sizes[0];
  let minDiff = Math.abs(closest - height);
  for (let i = 1; i < sizes.length; i++) {
    const d = Math.abs(sizes[i] - height);
    if (d < minDiff) {
      closest = sizes[i];
      minDiff = d;
    }
  }

  const productName = rows[0]?.name || "";
  const baseQuote = quoteFromBasePrices(productName, closest, qty);
  if (baseQuote) return baseQuote;

  const sizeRows = valid
    .filter((r) => r.size === closest)
    .sort((a, b) => a.quantity - b.quantity);
  if (!sizeRows.length) return null;

  let selected = sizeRows[0];
  for (const row of sizeRows) {
    if (qty >= row.quantity) selected = row;
  }

  const unitPrice = parseFloat(selected.price);
  const total = unitPrice * qty;
  const idx = sizeRows.findIndex((r) => r === selected);
  const next = sizeRows[idx + 1];
  const tierRange = next
    ? `${selected.quantity}-${next.quantity - 1}`
    : `${selected.quantity}+`;

  return {
    sizeUsed: closest,
    tierQty: selected.quantity,
    tierRange,
    unitPrice,
    total,
  };
}
