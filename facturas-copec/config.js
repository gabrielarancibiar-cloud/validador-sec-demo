/* Configuración Facturas Copec · VALEPAC */
window.FACTURAS_COPEC_CONFIG = {
  supabaseUrl: "https://emyskqnsyspzjrguycjk.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVteXNrcW5zeXNwempyZ3V5Y2prIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDg5NDcsImV4cCI6MjA5NTQ4NDk0N30.bLCSwgLCop1Gg4rCbunFe4YCP_KHxIIFGF28vR0XD-0",
  supabaseClientGlobal: "supabaseClient",
  defaultEds: "40098",
  tableName: "facturas_copec",
  importRpc: "importar_facturas_copec",
  updateRpc: "actualizar_factura_copec",
  paymentsTableName: "pagos_copec",
  paymentsDetailTableName: "pagos_copec_detalle",
  importPaymentsRpc: "importar_pagos_copec",
  savePaymentPdfRpc: "guardar_comprobante_pago_copec",
  reconcileAllPaymentsRpc: "reconciliar_todos_pagos_copec",
  analyzePaymentPdfEndpoint: "/api/analizar-comprobante-pago",
  paymentsPageSize: 30,
  maxPdfBytes: 4194304,
  pageSize: 50,
  maxRows: 5000,
  allowDemoMode: true
};
