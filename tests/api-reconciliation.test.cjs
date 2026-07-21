const assert = require("node:assert/strict");
const api = require("../api/conciliacion-bancaria.js");

const payload = {
  lote: { estacion: "40098", creado_por: "Prueba", ventana_minutos: 180 },
  mae: [
    { source_key: "MAE-2", source_row: 2, occurred_at: "2026-07-20 10:00:00", maquina: "40098", usuario: "Ana", tipo: "Depósito", moneda: "CLP", monto: 100000 }
  ],
  bci: [
    { source_key: "BCI-2", source_row: 2, occurred_at: "2026-07-20 10:02:00", fecha_contable: "2026-07-20", codigo_transaccion: "BCI-2", tipo: "DEPOSITOS", glosa: "Depósito en Caja Depositaria", monto: 100000, en_alcance: true },
    { source_key: "BCI-3", source_row: 3, occurred_at: "2026-07-20 11:00:00", fecha_contable: "2026-07-20", codigo_transaccion: "BCI-3", tipo: "DEPOSITOS", glosa: "Deposito En Efectivo Por Caja", monto: 50000, en_alcance: false, motivo_exclusion: "Depósito manual por caja" }
  ]
};

const normalized = api._test.validateAndReconcile(payload);
assert.equal(normalized.lote.conciliados_cantidad, 1);
assert.equal(normalized.lote.conciliados_monto, 100000);
assert.equal(normalized.lote.fuera_alcance_cantidad, 1);
assert.equal(normalized.matches.length, 1);

const fakeXlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
const decoded = api._test.decodeExcelFile({ name: "prueba.xlsx", base64: fakeXlsx.toString("base64") }, "MAE");
assert.equal(decoded.buffer.length, fakeXlsx.length);
assert.equal(api._test.safeFileName("cartola julio (final).xlsx"), "cartola_julio_final_.xlsx");

console.log("Pruebas del servidor de conciliación: OK");
