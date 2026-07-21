# Conciliación MAE · BCI

El módulo está disponible en `/conciliacion-bancaria` y se enlaza desde la navegación y los accesos rápidos de VALEPAC.

## Funcionamiento

1. Carga el reporte Excel de depósitos MAE.
2. Carga la cartola de movimientos detallados BCI.
3. El módulo conserva solo las filas `Depósito` de MAE.
4. En BCI, concilia únicamente movimientos `DEPOSITOS` cuya glosa contiene `Caja Depositaria`.
5. Cada depósito MAE se relaciona una sola vez con el abono BCI del mismo importe más cercano, dentro de la ventana elegida.
6. Los depósitos manuales por caja y los cheques se muestran como fuera de alcance.

El servidor repite el cálculo antes de guardar. Los totales persistidos no dependen de los resultados enviados por el navegador.

## Activación en Supabase y Vercel

1. Ejecutar `supabase/migrations/20260721_conciliacion_bancaria.sql` en el SQL Editor de Supabase.
2. Configurar en Vercel:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Mantener también configuradas las variables existentes del portal, como `PORTAL_GATE_USER` y `PORTAL_GATE_PASS`.
4. Publicar el repositorio. Vercel ejecutará `npm run build` y expondrá la nueva ruta.

La clave `SUPABASE_SERVICE_ROLE_KEY` solo se utiliza en la función del servidor y nunca se envía al navegador.

## Datos almacenados

- `conciliacion_lotes`: resumen, período, reglas y referencias a los archivos.
- `conciliacion_mae`: depósitos normalizados de la máquina.
- `conciliacion_bci`: depósitos BCI normalizados y clasificación de alcance.
- `conciliacion_matches`: relaciones uno-a-uno confirmadas por el motor.
- Bucket privado `conciliaciones-bancarias`: archivos Excel originales.

La combinación de hashes SHA-256 de ambos archivos es única, evitando guardar dos veces el mismo lote.

## Verificación local

- `npm test` valida el motor con casos sintéticos.
- `npm run build` prepara `dist/` con la portada y los tres módulos estáticos.
