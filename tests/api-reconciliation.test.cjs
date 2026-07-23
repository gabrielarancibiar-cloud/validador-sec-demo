const assert = require("node:assert/strict");
const api = require("../api/conciliacion-bancaria.js");

const payload = {
  lote: { estacion: "40098", creado_por: "Prueba", ventana_minutos: 180 },
  mae: [
    { source_key: "MAE-2", source_row: 2, occurred_at: "2026-07-20 10:00:00", maquina: "40098", usuario: "Ana", tipo: "Depósito", moneda: "CLP", monto: 100000 }
  ],
  bci: [
    { source_key: "BCI-2", source_row: 2, occurred_at: "2026-07-20 10:02:00", fecha_contable: "2026-07-20", codigo_transaccion: "BCI-2", tipo: "DEPOSITOS", glosa: "Depósito en Caja Depositaria", monto: 100000, en_alcance: true },
    { source_key: "BCI-3", source_row: 3, occurred_at: "2026-07-20 11:00:00", fecha_contable: "2026-07-20", codigo_transaccion: "BCI-3", tipo: "DEPOSITOS", glosa: "Deposito En Efectivo Por Caja", monto: 50000, en_alcance: false, motivo_exclusion: "Depósito manual por caja" },
    { source_key: "GRUPO|ABONO", source_row: 4, occurred_at: "2026-07-20 23:53:00", fecha_contable: "2026-07-20", codigo_transaccion: "GRUPO|ABONO", tipo: "DEPOSITOS", glosa: "Depósito en Caja Depositaria", monto: 244000, en_alcance: true },
    { source_key: "GRUPO|REVERSA", source_row: 5, occurred_at: "2026-07-21 15:28:00", fecha_contable: "2026-07-21", codigo_transaccion: "GRUPO|REVERSA", tipo: "", glosa: "Reversa De Abono", monto: 244000, en_alcance: false, es_reversa: true }
  ]
};

const normalized = api._test.validateAndPrepareFlow(payload);
assert.equal(normalized.mae.length, 1);
assert.equal(normalized.bci.length, 4);
assert.match(normalized.mae[0].registro_id, /^[0-9a-f]{64}$/);
assert.match(normalized.bci[0].registro_id, /^[0-9a-f]{64}$/);

const repeated = api._test.validateAndPrepareFlow(payload);
assert.equal(repeated.mae[0].registro_id, normalized.mae[0].registro_id);
assert.equal(repeated.bci[0].registro_id, normalized.bci[0].registro_id);

const ledger = api._test.buildLedgerResult(
  payload.mae.map(api._test.normalizeMaeRow),
  payload.bci.map(api._test.normalizeBciRow),
  180
);
const reversalRow = ledger.rows.find(row => row.statusKey === "reversa_bci");
assert.ok(reversalRow);
assert.equal(reversalRow.reversal.matched, true);
assert.equal(reversalRow.amount, 244000);
assert.equal(ledger.summary.reversalCount, 1);
assert.equal(ledger.rows.some(row => row.statusKey === "pendiente_bci" && row.amount === 244000), false);
assert.equal(api._test.transactionGroup("GRUPO|ABONO"), "grupo");

const maeOnly = api._test.validateAndPrepareFlow({ mae: payload.mae });
assert.equal(maeOnly.mae.length, 1);
assert.equal(maeOnly.bci.length, 0);
assert.throws(() => api._test.validateAndPrepareFlow({ mae: [], bci: [] }), /al menos un archivo/i);

const fakeXlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
const decoded = api._test.decodeExcelFile({ name: "prueba.xlsx", base64: fakeXlsx.toString("base64") }, "MAE");
assert.equal(decoded.buffer.length, fakeXlsx.length);
assert.equal(api._test.safeFileName("cartola julio (final).xlsx"), "cartola_julio_final_.xlsx");
assert.equal(api._test.getQueryValue(["180"]), "180");
assert.equal(api._test.clampWindow("9999"), 1440);

const compact = api._test.compactResult({
  periodStart: "2026-07-01", periodEnd: "2026-07-31", windowMinutes: 180, summary: { matchedCount: 1 },
  rows: [{
    statusKey: "conciliado", statusLabel: "Conciliado", amount: 100000, deltaSeconds: 120, crossesDay: false,
    mae: { sourceKey: "interno", dateTime: "2026-07-20 10:00:00", dateKey: "2026-07-20", user: "Ana", machine: "40098", amount: 100000 },
    bci: { sourceKey: "interno", dateTime: "2026-07-20 10:02:00", dateKey: "2026-07-20", detail: "Caja Depositaria", transactionCode: "BCI-2", amount: 100000 }
  }]
});
assert.equal(compact.rows[0].mae.sourceKey, undefined);
assert.equal(compact.rows[0].bci.transactionCode, "BCI-2");

console.log("Pruebas del servidor de conciliación: OK");
