window.CALCULO_COMBUSTIBLE_CONFIG = {
  supabaseUrl: "https://emyskqnsyspzjrguycjk.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVteXNrcW5zeXNwempyZ3V5Y2prIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDg5NDcsImV4cCI6MjA5NTQ4NDk0N30.bLCSwgLCop1Gg4rCbunFe4YCP_KHxIIFGF28vR0XD-0",
  estacion: "40098",
  intervaloMinutos: 30,
  pageSize: 1000,
  batchSize: 400,
  tablas: {
    ventas: "combustible_ventas_30m",
    telemediciones: "combustible_telemediciones",
    importaciones: "combustible_importaciones",
    escenarios: "combustible_escenarios"
  }
};
