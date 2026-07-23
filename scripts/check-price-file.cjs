const fs = require("node:fs");
const readline = require("node:readline");
const core = require("../validador-precios-gasolina/price-change-core.js");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Uso: node scripts/check-price-file.cjs <archivo.csv>");
  process.exit(1);
}

function parseLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

async function run() {
  const reader = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let headers = null;
  let rowNumber = 1;
  const sales = [];

  for await (const line of reader) {
    if (!headers) {
      headers = parseLine(line.replace(/^\uFEFF/, "")).map(core.normalizeText);
      continue;
    }
    rowNumber += 1;
    if (!line.trim()) continue;
    const cells = parseLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    const sale = core.rowToSale(row, rowNumber);
    if (sale) sales.push(sale);
  }

  const result = core.analyzeStablePeriods(sales, {
    minVariation: 80,
    maxVariation: 130,
    stableTolerance: 35,
    transitionLookAhead: 8,
    transitionConfirmationSales: 3,
    confirmationWindowMinutes: 120
  });
  console.log(JSON.stringify({
    gasolineRows: sales.length,
    ...result.summary,
    dateFrom: result.summary.dateFrom?.toISOString(),
    dateTo: result.summary.dateTo?.toISOString(),
    periods: result.periods.map((period) => ({
      product: period.product,
      sequence: period.sequence,
      stablePrice: period.stablePrice,
      direction: period.direction,
      changeDelta: period.changeDelta,
      start: period.start?.toISOString(),
      end: period.end?.toISOString(),
      stableSales: period.stableSales.length,
      stableLiters: period.stableLiters,
      exceptionSales: period.exceptionSales.length,
      exceptionLiters: period.exceptionLiters,
      prices: period.priceBreakdown.map((item) => `${item.price}:${item.liters}`)
    }))
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
