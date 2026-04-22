// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const rawUnitPrice =
      line.attribute?.value ||
      line.customPriceCamel?.value ||
      line.calculatedUnitPrice?.value ||
      "";
    const unitFromCustom = parseMoneyLikeNumber(rawUnitPrice);
    const calculatedTotal = parseMoneyLikeNumber(line.calculatedTotal?.value || "");
    const qty = Number(line.quantity || 0);
    let price = unitFromCustom;

    // If display total conflicts with custom unit price, trust total/qty.
    if (Number.isFinite(calculatedTotal) && calculatedTotal > 0 && qty > 0) {
      const unitFromTotal = calculatedTotal / qty;
      if (!Number.isFinite(price) || price <= 0) {
        price = unitFromTotal;
      } else {
        const expectedTotal = price * qty;
        const mismatchRatio = Math.abs(expectedTotal - calculatedTotal) / calculatedTotal;
        if (mismatchRatio > 0.05) {
          price = unitFromTotal;
        }
      }
    }

    if (!Number.isFinite(price) || price <= 0) continue;

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: price.toFixed(2),
            },
          },
        },
      },
    });
  }

  return { operations };
}

function parseMoneyLikeNumber(value) {
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return NaN;
  return Number.parseFloat(cleaned);
}
