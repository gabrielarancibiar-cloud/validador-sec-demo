/*
 * CONFIGURACIÓN DEL MÓDULO FACTURAS COPEC
 *
 * Opción A (recomendada): reutilizar el cliente Supabase del portal.
 * Antes de cargar facturas-copec.js, deje disponible:
 *   window.supabaseClient = suClienteSupabase;
 *
 * Opción B: copie aquí la URL pública y la ANON KEY del mismo proyecto.
 * NUNCA coloque la SERVICE_ROLE_KEY en un archivo del navegador.
 */
window.FACTURAS_COPEC_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseClientGlobal: "supabaseClient",
  defaultEds: "40098",
  tableName: "facturas_copec",
  importRpc: "importar_facturas_copec",
  updateRpc: "actualizar_factura_copec",
  pageSize: 50,
  maxRows: 5000,
  allowDemoMode: true
};
