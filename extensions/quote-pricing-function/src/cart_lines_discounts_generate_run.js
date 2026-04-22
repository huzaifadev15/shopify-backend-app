import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';


/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  // If cart-transform custom pricing is present, skip discount function
  // to avoid stacking/conflicting adjustments at checkout.
  const hasCustomPriceLine = input.cart.lines.some((line) => {
    const raw = line?.attribute?.value;
    if (!raw) return false;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0;
  });
  if (hasCustomPriceLine) {
    return {operations: []};
  }

  const hasOrderDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Order,
  );
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasOrderDiscountClass && !hasProductDiscountClass) {
    return {operations: []};
  }

  const totalQty = input.cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  const discountPercent = getDiscountPercentByQuantity(totalQty);
  if (discountPercent <= 0) {
    return {operations: []};
  }

  const operations = [];

  if (hasOrderDiscountClass) {
    operations.push({
      orderDiscountsAdd: {
        candidates: [
          {
            message: `${discountPercent}% OFF (QTY ${totalQty})`,
            targets: [
              {
                orderSubtotal: {
                  excludedCartLineIds: [],
                },
              },
            ],
            value: {
              percentage: {
                value: discountPercent,
              },
            },
          },
        ],
        selectionStrategy: OrderDiscountSelectionStrategy.First,
      },
    });
  }

  return {
    operations,
  };
}

function getDiscountPercentByQuantity(quantity) {
  if (quantity >= 100) return 20;
  if (quantity >= 50) return 15;
  if (quantity >= 25) return 10;
  if (quantity >= 10) return 5;
  return 0;
}