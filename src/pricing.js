import pricingData from "../data/pricing.json" with { type: "json" };

export async function loadPricing(_relativePath) {
  return pricingData;
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
    productName
  ].filter(Boolean);

  for (const alias of aliases) {
    const exact = rows.filter((r) => normalize(r.name) === normalize(alias));
    if (exact.length) return exact;
  }

  return rows.filter(
    (r) =>
      normalize(r.name).includes(normalize("3D Embroidered")) ||
      normalize(r.name).includes(normalize(productName))
  );
}

export function quoteFromRows(rows, { height, qty }) {
  const valid = rows.filter(
    (r) =>
      typeof r.size === "number" &&
      typeof r.quantity === "number" &&
      !Number.isNaN(parseFloat(r.price))
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
    total
  };
}
