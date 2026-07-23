const assert = require("node:assert/strict");
const core = require("../validador-precios-gasolina/price-change-core.js");

function sale(product, price, timestamp, rowNumber) {
  return {
    product,
    price,
    timestamp: new Date(timestamp),
    rowNumber,
    transactionCode: `T-${rowNumber}`,
    attendant: "Atendedor prueba",
    pos: "1",
    paymentMethod: "EFECTIVO",
    discount: 0,
    paymentDiscount: 0
  };
}

assert.equal(core.parseLocaleNumber("$1.509"), 1509);
assert.equal(core.parseLocaleNumber("1.509,5"), 1509.5);
assert.equal(core.normalizeProduct("gasolina 95"), "Gasolina 95");
assert.equal(core.parseDate("2026-07-03 11:51:53").getFullYear(), 2026);

const parsed = core.rowToSale({
  "CATEGORIA NOMBRE": "GASOLINAS",
  "PRODUCTO": "Gasolina 93",
  "PRECIO": "1409",
  "FECHA CIERRE TRANSACCION": "2026-07-03 11:51:53",
  "TRANSACCION CODIGO": "N4009800001",
  "ATENDEDOR": "Persona",
  "POS Nº": "3"
}, 22);
assert.equal(parsed.product, "Gasolina 93");
assert.equal(parsed.price, 1409);
assert.equal(parsed.transactionCode, "N4009800001");
assert.equal(parsed.rowNumber, 22);

const result = core.analyzeSales([
  sale("Gasolina 93", 1509, "2026-07-03T11:45:00", 1),
  sale("Gasolina 93", 1409, "2026-07-03T11:50:00", 2),
  sale("Gasolina 93", 1405, "2026-07-03T11:54:00", 3),
  sale("Gasolina 93", 1409, "2026-07-03T11:58:00", 4),
  sale("Gasolina 93", 1509, "2026-07-03T12:01:00", 5),
  sale("Gasolina 95", 0, "2026-07-03T12:02:00", 6)
], {
  minVariation: 80,
  maxVariation: 130,
  maxGapMinutes: 60,
  confirmationTolerance: 35,
  confirmationLookAhead: 4,
  confirmationMinimum: 2,
  confirmationWindowMinutes: 60,
  eventWindowMinutes: 45
});

assert.equal(result.summary.validSales, 5);
assert.equal(result.summary.invalidPrice, 1);
assert.equal(result.summary.changes, 2);
assert.equal(result.summary.down, 1);
assert.equal(result.summary.up, 1);
assert.equal(result.changes[0].validation, "consistent");
assert.equal(result.changes[1].validation, "insufficient");
assert.equal(result.summary.eventCount, 1);

console.log("price-change-core.test.cjs: OK");
