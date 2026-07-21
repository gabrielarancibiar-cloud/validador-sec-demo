const assert = require("node:assert/strict");
const core = require("../conciliacion-bancaria/reconciliation-core.js");

const maeMatrix = [
  ["Fecha transacción", "Nombre CashToday", "Nombre cliente", "Nombre usuario", "Tipo transacción", "Divisa", "Importe"],
  ["20-07-2026 10:00:00", "40098 MAE", "COPEC", "Ana", "Depósito", "CLP", 100000],
  ["20-07-2026 11:00:00", "40098 MAE", "COPEC", "Luis", "Depósito", "CLP", 200000],
  ["20-07-2026 12:00:00", "40098 MAE", "COPEC", "Ana", "Recogida", "CLP", 300000]
];

const bciMatrix = [
  ["Fecha de transacción", "Hora transacción", "Fecha contable", "Código de transacción", "Tipo de transacción", "Glosa detalle", "Ingreso (+)"],
  [46223, "10:02", 46223, "BCI-1", "DEPOSITOS", "Depósito en Caja Depositaria", 100000],
  [46223, "13:30", 46223, "BCI-2", "DEPOSITOS", "Depósito en Caja Depositaria", 200000],
  [46223, "14:00", 46223, "BCI-3", "DEPOSITOS", "Depósito en Caja Depositaria", 50000],
  [46223, "14:05", 46223, "BCI-4", "DEPOSITOS", "Deposito En Efectivo Por Caja", 25000]
];

const mae = core.parseMaeMatrix(maeMatrix);
const bci = core.parseBciMatrix(bciMatrix);
const result = core.reconcile(mae, bci, { windowMinutes: 180 });

assert.equal(core.parseAmount("1.477.000,00"), 1477000);
assert.equal(core.parseAmount("1,477,000.00"), 1477000);
assert.equal(mae.deposits.length, 2);
assert.equal(mae.pickups.length, 1);
assert.equal(bci.inScope.length, 3);
assert.equal(bci.excluded.length, 1);
assert.equal(result.summary.matchedCount, 2);
assert.equal(result.summary.matchedAmount, 300000);
assert.equal(result.summary.pendingMaeCount, 0);
assert.equal(result.summary.pendingBciCount, 1);
assert.equal(result.summary.pendingBciAmount, 50000);
assert.equal(result.summary.excludedBciAmount, 25000);
assert.equal(result.summary.delayedCount, 1);

console.log("Pruebas de conciliación: OK");
