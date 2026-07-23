(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PriceChangeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MINUTE_MS = 60 * 1000;

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toUpperCase();
  }

  function parseLocaleNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (value === null || value === undefined || value === "") return NaN;
    let text = String(value).trim().replace(/\s/g, "").replace(/\$/g, "");
    if (!text) return NaN;

    if (text.includes(",") && text.includes(".")) {
      if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
        text = text.replace(/\./g, "").replace(",", ".");
      } else {
        text = text.replace(/,/g, "");
      }
    } else if (text.includes(",")) {
      const decimals = text.length - text.lastIndexOf(",") - 1;
      text = decimals === 3 && Number(text.replace(",", "")) > 500
        ? text.replace(/,/g, "")
        : text.replace(",", ".");
    } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, "");
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function parseDecimalNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (value === null || value === undefined || value === "") return NaN;
    let text = String(value).trim().replace(/\s/g, "").replace(/\$/g, "");
    if (!text) return NaN;
    if (text.includes(",") && text.includes(".")) {
      if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
        text = text.replace(/\./g, "").replace(",", ".");
      } else {
        text = text.replace(/,/g, "");
      }
    } else if (text.includes(",")) {
      text = text.replace(",", ".");
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isValidDate(value) {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }

  function parseDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (value === null || value === undefined || value === "") return null;
    const text = String(value).trim();
    if (!text) return null;

    const iso = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
      const date = new Date(
        Number(iso[1]),
        Number(iso[2]) - 1,
        Number(iso[3]),
        Number(iso[4] || 0),
        Number(iso[5] || 0),
        Number(iso[6] || 0)
      );
      return isValidDate(date) ? date : null;
    }

    const local = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (local) {
      const date = new Date(
        Number(local[3]),
        Number(local[2]) - 1,
        Number(local[1]),
        Number(local[4] || 0),
        Number(local[5] || 0),
        Number(local[6] || 0)
      );
      return isValidDate(date) ? date : null;
    }

    const fallback = new Date(text);
    return isValidDate(fallback) ? fallback : null;
  }

  function normalizeProduct(value) {
    const normalized = normalizeText(value);
    if (normalized.includes("GASOLINA 93") || normalized === "93") return "Gasolina 93";
    if (normalized.includes("GASOLINA 95") || normalized === "95") return "Gasolina 95";
    if (normalized.includes("GASOLINA 97") || normalized === "97") return "Gasolina 97";
    return "";
  }

  function field(row, names) {
    for (const name of names) {
      const key = normalizeText(name);
      if (Object.prototype.hasOwnProperty.call(row || {}, key)) return row[key];
    }
    return undefined;
  }

  function rowToSale(row, rowNumber) {
    const product = normalizeProduct(field(row, ["PRODUCTO"]));
    const category = normalizeText(field(row, ["CATEGORIA NOMBRE", "CATEGORÍA NOMBRE"]));
    if (!product || (category && !category.includes("GASOLINA"))) return null;

    const closeDate = field(row, ["FECHA CIERRE TRANSACCION", "FECHA CIERRE TRANSACCIÓN"]);
    const saleDate = field(row, ["FECHA TRANSACCION", "FECHA TRANSACCIÓN"]);
    const saleTime = field(row, ["HORA TRANSACCION", "HORA TRANSACCIÓN"]);
    const timestamp = closeDate
      ? parseDate(closeDate)
      : parseDate(`${String(saleDate || "").trim()} ${String(saleTime || "00:00:00").trim()}`);

    return {
      rowNumber: Number(rowNumber) || 0,
      product,
      price: parseLocaleNumber(field(row, ["PRECIO"])),
      liters: parseDecimalNumber(field(row, ["CANTIDAD"])),
      timestamp,
      transactionId: String(field(row, ["TRANSACCION ID", "TRANSACCIÓN ID"]) || "").trim(),
      transactionCode: String(field(row, ["TRANSACCION CODIGO", "TRANSACCIÓN CÓDIGO"]) || "").trim(),
      attendant: String(field(row, ["ATENDEDOR"]) || "").trim(),
      pos: String(field(row, ["POS N°", "POS Nº", "POS NO", "POS NUMERO"]) || "").trim(),
      pump: String(field(row, ["SURTIDOR ID"]) || "").trim(),
      paymentMethod: String(field(row, ["FORMA PAGO"]) || "").trim(),
      discount: parseLocaleNumber(field(row, ["DESCUENTO"])),
      paymentDiscount: parseLocaleNumber(field(row, ["TOTAL DESCUENTO PAGO"])),
      total: parseLocaleNumber(field(row, ["TOTAL"])),
      totalPaid: parseLocaleNumber(field(row, ["TOTAL A PAGAR"]))
    };
  }

  function normalizeOptions(options) {
    const raw = options || {};
    const minVariation = Math.max(0, Number(raw.minVariation) || 80);
    const maxVariation = Math.max(minVariation, Number(raw.maxVariation) || 130);
    return {
      minVariation,
      maxVariation,
      maxGapMinutes: Math.max(0, Number(raw.maxGapMinutes) || 60),
      minValidPrice: Math.max(0, Number(raw.minValidPrice) || 500),
      maxValidPrice: Math.max(0, Number(raw.maxValidPrice) || 4000),
      confirmationTolerance: Math.max(0, Number(raw.confirmationTolerance) || 35),
      confirmationLookAhead: Math.max(1, Math.round(Number(raw.confirmationLookAhead) || 4)),
      confirmationMinimum: Math.max(1, Math.round(Number(raw.confirmationMinimum) || 2)),
      confirmationWindowMinutes: Math.max(1, Number(raw.confirmationWindowMinutes) || 60),
      eventWindowMinutes: Math.max(1, Number(raw.eventWindowMinutes) || 45)
    };
  }

  function analyzeSales(inputSales, options) {
    const opts = normalizeOptions(options);
    const sales = Array.isArray(inputSales) ? inputSales : [];
    const invalidPrice = [];
    const validSales = [];

    sales.forEach((sale) => {
      if (!sale || !sale.product || !isValidDate(sale.timestamp)) return;
      if (!Number.isFinite(sale.price) || sale.price < opts.minValidPrice || sale.price > opts.maxValidPrice) {
        invalidPrice.push(sale);
        return;
      }
      validSales.push({ ...sale, timestamp: new Date(sale.timestamp) });
    });

    const byProduct = new Map();
    validSales.forEach((sale) => {
      if (!byProduct.has(sale.product)) byProduct.set(sale.product, []);
      byProduct.get(sale.product).push(sale);
    });

    const changes = [];
    for (const productSales of byProduct.values()) {
      productSales.sort((a, b) => a.timestamp - b.timestamp || a.rowNumber - b.rowNumber);
      for (let index = 1; index < productSales.length; index += 1) {
        const previous = productSales[index - 1];
        const current = productSales[index];
        const gapMinutes = (current.timestamp - previous.timestamp) / MINUTE_MS;
        const delta = current.price - previous.price;
        const absoluteDelta = Math.abs(delta);

        if (gapMinutes < 0 || gapMinutes > opts.maxGapMinutes) continue;
        if (absoluteDelta < opts.minVariation || absoluteDelta > opts.maxVariation) continue;

        const future = [];
        for (
          let cursor = index + 1;
          cursor < productSales.length && future.length < opts.confirmationLookAhead;
          cursor += 1
        ) {
          const candidate = productSales[cursor];
          const futureGap = (candidate.timestamp - current.timestamp) / MINUTE_MS;
          if (futureGap > opts.confirmationWindowMinutes) break;
          future.push(candidate);
        }

        const supportingSales = future.filter((candidate) =>
          Math.abs(candidate.price - current.price) <= opts.confirmationTolerance
        ).length;
        const validation = supportingSales >= opts.confirmationMinimum
          ? "consistent"
          : future.length >= opts.confirmationMinimum
            ? "review"
            : "insufficient";

        changes.push({
          key: [
            current.transactionCode || current.transactionId || current.rowNumber,
            current.timestamp.getTime(),
            previous.price,
            current.price
          ].join("|"),
          product: current.product,
          direction: delta < 0 ? "down" : "up",
          previousPrice: previous.price,
          currentPrice: current.price,
          delta,
          absoluteDelta,
          gapMinutes,
          previous,
          current,
          supportingSales,
          futureSampleSize: future.length,
          validation
        });
      }
    }

    changes.sort((a, b) => a.current.timestamp - b.current.timestamp || a.current.rowNumber - b.current.rowNumber);
    const events = groupEvents(changes, opts.eventWindowMinutes);
    const dates = validSales.map((sale) => sale.timestamp.getTime());

    return {
      options: opts,
      validSales,
      invalidPrice,
      changes,
      events,
      summary: {
        sourceRows: sales.length,
        validSales: validSales.length,
        invalidPrice: invalidPrice.length,
        changes: changes.length,
        down: changes.filter((change) => change.direction === "down").length,
        up: changes.filter((change) => change.direction === "up").length,
        consistent: changes.filter((change) => change.validation === "consistent").length,
        review: changes.filter((change) => change.validation !== "consistent").length,
        eventCount: events.length,
        productCount: byProduct.size,
        dateFrom: dates.length ? new Date(Math.min(...dates)) : null,
        dateTo: dates.length ? new Date(Math.max(...dates)) : null
      }
    };
  }

  function analyzeStablePeriods(inputSales, options) {
    const opts = normalizePeriodOptions(options);
    const sales = Array.isArray(inputSales) ? inputSales : [];
    const invalidPrice = [];
    const invalidLiters = [];
    const validSales = [];

    sales.forEach((sale) => {
      if (!sale || !sale.product || !isValidDate(sale.timestamp)) return;
      if (!Number.isFinite(sale.price) || sale.price < opts.minValidPrice || sale.price > opts.maxValidPrice) {
        invalidPrice.push(sale);
        return;
      }
      if (!Number.isFinite(sale.liters) || sale.liters <= 0) {
        invalidLiters.push(sale);
        return;
      }
      validSales.push({ ...sale, timestamp: new Date(sale.timestamp) });
    });

    const byProduct = new Map();
    validSales.forEach((sale) => {
      if (!byProduct.has(sale.product)) byProduct.set(sale.product, []);
      byProduct.get(sale.product).push(sale);
    });

    const periods = [];
    const transitions = [];
    for (const [product, productSales] of byProduct.entries()) {
      productSales.sort((a, b) => a.timestamp - b.timestamp || a.rowNumber - b.rowNumber);
      if (!productSales.length) continue;

      const initialSeed = productSales.slice(0, Math.min(opts.seedSales, productSales.length));
      let current = createPeriod(product, dominantPrice(initialSeed, opts.stableTolerance), null, 1);

      for (let index = 0; index < productSales.length; index += 1) {
        const sale = productSales[index];
        const distance = sale.price - current.stablePrice;
        if (Math.abs(distance) <= opts.stableTolerance) {
          addStableSale(current, sale);
          continue;
        }

        const transition = confirmPeriodTransition(productSales, index, current.stablePrice, opts);
        if (!transition.confirmed) {
          addExceptionSale(current, sale);
          continue;
        }

        const previousSale = productSales[index - 1] || sale;
        finalizePeriod(current, previousSale.timestamp);
        periods.push(current);

        const delta = transition.stablePrice - current.stablePrice;
        current = createPeriod(
          product,
          transition.stablePrice,
          {
            direction: delta < 0 ? "down" : "up",
            delta,
            previousPrice: current.stablePrice,
            confirmationSales: transition.confirmationSales
          },
          current.sequence + 1
        );
        addStableSale(current, sale);
        transitions.push({
          product,
          timestamp: new Date(sale.timestamp),
          direction: delta < 0 ? "down" : "up",
          delta,
          previousPrice: current.previousPrice,
          newPrice: transition.stablePrice,
          confirmationSales: transition.confirmationSales,
          sale
        });
      }

      finalizePeriod(current, productSales[productSales.length - 1].timestamp);
      periods.push(current);
    }

    periods.sort((a, b) => a.start - b.start || a.product.localeCompare(b.product));
    transitions.sort((a, b) => a.timestamp - b.timestamp || a.product.localeCompare(b.product));
    const allTimestamps = validSales.map((sale) => sale.timestamp.getTime());
    const totalLiters = sum(validSales.map((sale) => sale.liters));
    const stableLiters = sum(periods.map((period) => period.stableLiters));
    const exceptionLiters = sum(periods.map((period) => period.exceptionLiters));

    return {
      options: opts,
      validSales,
      invalidPrice,
      invalidLiters,
      periods,
      transitions,
      summary: {
        sourceRows: sales.length,
        validSales: validSales.length,
        invalidPrice: invalidPrice.length,
        invalidLiters: invalidLiters.length,
        periods: periods.length,
        transitions: transitions.length,
        down: transitions.filter((item) => item.direction === "down").length,
        up: transitions.filter((item) => item.direction === "up").length,
        productCount: byProduct.size,
        totalLiters,
        stableLiters,
        exceptionLiters,
        stableCoverage: totalLiters ? stableLiters / totalLiters : 0,
        dateFrom: allTimestamps.length ? new Date(Math.min(...allTimestamps)) : null,
        dateTo: allTimestamps.length ? new Date(Math.max(...allTimestamps)) : null
      }
    };
  }

  function normalizePeriodOptions(options) {
    const base = normalizeOptions(options);
    const raw = options || {};
    return {
      ...base,
      stableTolerance: Math.max(0, Number(raw.stableTolerance) || 35),
      seedSales: Math.max(1, Math.round(Number(raw.seedSales) || 8)),
      transitionLookAhead: Math.max(2, Math.round(Number(raw.transitionLookAhead) || 8)),
      transitionConfirmationSales: Math.max(2, Math.round(Number(raw.transitionConfirmationSales) || 3)),
      confirmationWindowMinutes: Math.max(1, Number(raw.confirmationWindowMinutes) || 120)
    };
  }

  function createPeriod(product, stablePrice, change, sequence) {
    return {
      id: `${product.replace(/\s+/g, "-").toLowerCase()}-${sequence}`,
      product,
      sequence,
      stablePrice,
      previousPrice: change?.previousPrice ?? null,
      direction: change?.direction || "initial",
      changeDelta: change?.delta ?? null,
      confirmationSales: change?.confirmationSales || 0,
      start: null,
      end: null,
      stableSales: [],
      exceptionSales: [],
      stableLiters: 0,
      exceptionLiters: 0,
      totalLiters: 0,
      priceBreakdown: [],
      _priceStats: new Map(),
      _dominantCount: 0
    };
  }

  function addStableSale(period, sale) {
    period.stableSales.push(sale);
    period.stableLiters += sale.liters;
    period.totalLiters += sale.liters;
    if (!period.start || sale.timestamp < period.start) period.start = new Date(sale.timestamp);
    if (!period.end || sale.timestamp > period.end) period.end = new Date(sale.timestamp);
    const priceKey = String(sale.price);
    if (!period._priceStats.has(priceKey)) {
      period._priceStats.set(priceKey, { price: sale.price, sales: 0, liters: 0 });
    }
    const priceStat = period._priceStats.get(priceKey);
    priceStat.sales += 1;
    priceStat.liters += sale.liters;
    if (
      priceStat.sales > period._dominantCount ||
      (priceStat.sales === period._dominantCount && sale.price > period.stablePrice)
    ) {
      period.stablePrice = sale.price;
      period._dominantCount = priceStat.sales;
    }
  }

  function addExceptionSale(period, sale) {
    period.exceptionSales.push(sale);
    period.exceptionLiters += sale.liters;
    period.totalLiters += sale.liters;
    if (!period.start || sale.timestamp < period.start) period.start = new Date(sale.timestamp);
    if (!period.end || sale.timestamp > period.end) period.end = new Date(sale.timestamp);
  }

  function finalizePeriod(period, fallbackEnd) {
    if (!period.start) period.start = fallbackEnd ? new Date(fallbackEnd) : null;
    period.end = fallbackEnd ? new Date(fallbackEnd) : period.end;
    period.priceBreakdown = [...period._priceStats.values()]
      .map((item) => ({ ...item, liters: round(item.liters, 3) }))
      .sort((a, b) => b.sales - a.sales || b.liters - a.liters || b.price - a.price);
    period.stableLiters = round(period.stableLiters, 3);
    period.exceptionLiters = round(period.exceptionLiters, 3);
    period.totalLiters = round(period.totalLiters, 3);
    delete period._priceStats;
    delete period._dominantCount;
  }

  function confirmPeriodTransition(productSales, index, currentStablePrice, options) {
    const candidate = productSales[index];
    const nearby = [];
    for (
      let cursor = index;
      cursor < productSales.length && cursor <= index + options.transitionLookAhead;
      cursor += 1
    ) {
      const sale = productSales[cursor];
      const minutes = (sale.timestamp - candidate.timestamp) / MINUTE_MS;
      if (minutes > options.confirmationWindowMinutes) break;
      if (Math.abs(sale.price - candidate.price) <= options.stableTolerance) nearby.push(sale);
    }
    if (nearby.length < options.transitionConfirmationSales) return { confirmed: false };

    const stablePrice = dominantPrice(nearby, options.stableTolerance, candidate.price);
    const delta = stablePrice - currentStablePrice;
    const absoluteDelta = Math.abs(delta);
    if (absoluteDelta < options.minVariation || absoluteDelta > options.maxVariation) {
      return { confirmed: false };
    }
    return {
      confirmed: true,
      stablePrice,
      confirmationSales: nearby.length
    };
  }

  function dominantPrice(sales, tolerance, fallback) {
    const valid = (sales || []).filter((sale) => Number.isFinite(sale?.price));
    if (!valid.length) return Number(fallback) || 0;
    let bestCluster = [];
    valid.forEach((candidate) => {
      const cluster = valid.filter((sale) => Math.abs(sale.price - candidate.price) <= tolerance);
      if (cluster.length > bestCluster.length) bestCluster = cluster;
    });
    const counts = new Map();
    (bestCluster.length ? bestCluster : valid).forEach((sale) => {
      counts.set(sale.price, (counts.get(sale.price) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }

  function sum(values) {
    return (values || []).reduce((total, value) => total + (Number(value) || 0), 0);
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function groupEvents(changes, eventWindowMinutes) {
    const windowMs = Math.max(1, Number(eventWindowMinutes) || 45) * MINUTE_MS;
    const sorted = [...(changes || [])].sort((a, b) => a.current.timestamp - b.current.timestamp);
    const events = [];

    sorted.forEach((change) => {
      let event = events[events.length - 1];
      if (!event || change.current.timestamp - event.lastTimestamp > windowMs) {
        event = {
          id: events.length + 1,
          start: new Date(change.current.timestamp),
          end: new Date(change.current.timestamp),
          lastTimestamp: change.current.timestamp.getTime(),
          changes: [],
          products: [],
          down: 0,
          up: 0,
          consistent: 0
        };
        events.push(event);
      }
      event.changes.push(change);
      event.end = new Date(change.current.timestamp);
      event.lastTimestamp = change.current.timestamp.getTime();
      if (!event.products.includes(change.product)) event.products.push(change.product);
      event[change.direction] += 1;
      if (change.validation === "consistent") event.consistent += 1;
    });

    return events.map(({ lastTimestamp, ...event }) => event);
  }

  return {
    analyzeSales,
    analyzeStablePeriods,
    groupEvents,
    isValidDate,
    normalizeOptions,
    normalizeProduct,
    normalizeText,
    parseDate,
    parseDecimalNumber,
    parseLocaleNumber,
    rowToSale
  };
});
