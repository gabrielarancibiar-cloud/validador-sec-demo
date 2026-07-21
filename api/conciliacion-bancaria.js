const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const CORE = require("../conciliacion-bancaria/reconciliation-core.js");

const BUCKET = "conciliaciones-bancarias";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10000;

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb"
    }
  }
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }

  if (req.method === "GET") return listBatches(supabase, res);
  return saveBatch(supabase, req, res);
};

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

async function listBatches(supabase, res) {
  const { data, error } = await supabase
    .from("conciliacion_lotes")
    .select("id,created_at,creado_por,periodo_desde,periodo_hasta,mae_archivo_nombre,bci_archivo_nombre,conciliados_cantidad,conciliados_monto,pendiente_mae_cantidad,pendiente_bci_cantidad,estado")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return res.status(503).json({
      error: "Supabase está conectado, pero falta ejecutar la migración de conciliación bancaria."
    });
  }
  return res.status(200).json({ items: data || [] });
}

async function saveBatch(supabase, req, res) {
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    return res.status(400).json({ error: "El contenido enviado no es JSON válido." });
  }

  let normalized;
  let maeFile;
  let bciFile;
  try {
    normalized = validateAndReconcile(body);
    maeFile = decodeExcelFile(body.files?.mae, "MAE");
    bciFile = decodeExcelFile(body.files?.bci, "BCI");
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const batchId = crypto.randomUUID();
  const maePath = `${batchId}/mae_${safeFileName(maeFile.name)}`;
  const bciPath = `${batchId}/bci_${safeFileName(bciFile.name)}`;
  const uploaded = [];

  try {
    await uploadFile(supabase, maePath, maeFile);
    uploaded.push(maePath);
    await uploadFile(supabase, bciPath, bciFile);
    uploaded.push(bciPath);

    normalized.lote.id = batchId;
    normalized.lote.mae_archivo_nombre = maeFile.name;
    normalized.lote.mae_archivo_sha256 = sha256(maeFile.buffer);
    normalized.lote.mae_storage_path = maePath;
    normalized.lote.bci_archivo_nombre = bciFile.name;
    normalized.lote.bci_archivo_sha256 = sha256(bciFile.buffer);
    normalized.lote.bci_storage_path = bciPath;

    const { data, error } = await supabase.rpc("guardar_conciliacion_bancaria", { p_payload: normalized });
    if (error) {
      const duplicate = error.code === "23505" || /duplicate|duplicad/i.test(error.message || "");
      const failure = new Error(duplicate ? "Esta misma combinación de archivos ya fue guardada." : (error.message || "No fue posible guardar en Supabase."));
      failure.status = duplicate ? 409 : 500;
      throw failure;
    }

    return res.status(201).json({
      id: data || batchId,
      summary: normalized.lote.resumen,
      message: "Conciliación guardada."
    });
  } catch (error) {
    if (uploaded.length) {
      try { await supabase.storage.from(BUCKET).remove(uploaded); } catch (_) {}
    }
    return res.status(error.status || 500).json({ error: error.message || "No fue posible guardar la conciliación." });
  }
}

function validateAndReconcile(body) {
  if (!body || typeof body !== "object") throw new Error("Falta la conciliación.");
  if (!Array.isArray(body.mae) || !Array.isArray(body.bci)) throw new Error("Faltan los movimientos normalizados de MAE o BCI.");
  if (!body.mae.length || !body.bci.length) throw new Error("Los archivos no contienen movimientos suficientes.");
  if (body.mae.length > MAX_ROWS || body.bci.length > MAX_ROWS) throw new Error(`La carga supera el máximo de ${MAX_ROWS} movimientos por fuente.`);

  const maeRows = body.mae.map((row, index) => normalizeMaeRow(row, index));
  const bciRows = body.bci.map((row, index) => normalizeBciRow(row, index));
  ensureUnique(maeRows, "sourceKey", "El archivo MAE contiene claves duplicadas.");
  ensureUnique(bciRows, "sourceKey", "La cartola BCI contiene códigos de transacción duplicados.");

  const windowMinutes = Math.max(1, Math.min(1440, Number(body.lote?.ventana_minutos || 180)));
  const result = CORE.reconcile(
    { deposits: maeRows },
    { inScope: bciRows.filter(row => row.inScope), excluded: bciRows.filter(row => !row.inScope) },
    { windowMinutes }
  );

  const lote = {
    estacion: cleanText(body.lote?.estacion || "40098", 50),
    creado_por: cleanText(body.lote?.creado_por || "Usuario portal", 150),
    periodo_desde: result.periodStart,
    periodo_hasta: result.periodEnd,
    ventana_minutos: windowMinutes,
    mae_cantidad: result.summary.maeCount,
    mae_monto: result.summary.maeAmount,
    bci_caja_cantidad: result.summary.bciScopeCount,
    bci_caja_monto: result.summary.bciScopeAmount,
    conciliados_cantidad: result.summary.matchedCount,
    conciliados_monto: result.summary.matchedAmount,
    pendiente_mae_cantidad: result.summary.pendingMaeCount,
    pendiente_mae_monto: result.summary.pendingMaeAmount,
    pendiente_bci_cantidad: result.summary.pendingBciCount,
    pendiente_bci_monto: result.summary.pendingBciAmount,
    fuera_alcance_cantidad: result.summary.excludedBciCount,
    fuera_alcance_monto: result.summary.excludedBciAmount,
    resumen: result.summary,
    estado: result.summary.pendingMaeCount || result.summary.pendingBciCount ? "con_excepciones" : "conciliado"
  };

  return {
    lote,
    mae: maeRows.map(row => ({
      source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
      maquina: row.machine, cliente: row.client, usuario: row.user, tipo: row.type,
      moneda: row.currency, monto: row.amount
    })),
    bci: bciRows.map(row => ({
      source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
      fecha_contable: row.accountingDate || null, codigo_transaccion: row.transactionCode,
      tipo: row.type, glosa: row.detail, monto: row.amount, en_alcance: row.inScope,
      motivo_exclusion: row.excludedReason || null
    })),
    matches: result.matches.map(row => ({
      mae_source_key: row.mae.sourceKey, bci_source_key: row.bci.sourceKey,
      estado: row.statusKey, monto: row.amount, diferencia_segundos: row.deltaSeconds,
      cruza_dia: row.crossesDay
    }))
  };
}

function normalizeMaeRow(row, index) {
  const timestamp = CORE.parseDateTime(row?.occurred_at);
  const amount = positiveInteger(row?.monto, `Importe MAE inválido en la fila ${index + 1}.`);
  if (!timestamp) throw new Error(`Fecha MAE inválida en la fila ${index + 1}.`);
  return {
    sourceKey: cleanText(row.source_key || `MAE-${index + 1}`, 500),
    sourceRow: positiveRow(row.source_row, index),
    dateTime: timestamp.dateTime, dateKey: timestamp.dateKey, epoch: timestamp.epoch,
    machine: cleanText(row.maquina, 250), client: cleanText(row.cliente, 250),
    user: cleanText(row.usuario, 250), type: cleanText(row.tipo || "Depósito", 100),
    currency: cleanText(row.moneda || "CLP", 20), amount
  };
}

function normalizeBciRow(row, index) {
  const timestamp = CORE.parseDateTime(row?.occurred_at);
  const amount = positiveInteger(row?.monto, `Importe BCI inválido en la fila ${index + 1}.`);
  if (!timestamp) throw new Error(`Fecha BCI inválida en la fila ${index + 1}.`);
  const accounting = row?.fecha_contable ? CORE.parseDateTime(row.fecha_contable) : null;
  return {
    sourceKey: cleanText(row.source_key || row.codigo_transaccion || `BCI-${index + 1}`, 500),
    sourceRow: positiveRow(row.source_row, index),
    dateTime: timestamp.dateTime, dateKey: timestamp.dateKey, epoch: timestamp.epoch,
    accountingDate: accounting?.dateKey || "",
    transactionCode: cleanText(row.codigo_transaccion, 500), type: cleanText(row.tipo || "DEPOSITOS", 100),
    detail: cleanText(row.glosa, 500), amount, inScope: row.en_alcance === true,
    excludedReason: cleanText(row.motivo_exclusion, 200)
  };
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(message);
  return number;
}

function positiveRow(value, fallbackIndex) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallbackIndex + 1;
}

function ensureUnique(rows, key, message) {
  const values = new Set();
  for (const row of rows) {
    if (!row[key] || values.has(row[key])) throw new Error(message);
    values.add(row[key]);
  }
}

function decodeExcelFile(file, label) {
  if (!file || typeof file.base64 !== "string") throw new Error(`Falta el archivo original ${label}.`);
  const name = cleanText(file.name, 220);
  if (!/\.xlsx?$/i.test(name)) throw new Error(`El archivo ${label} debe ser .xlsx o .xls.`);
  const buffer = Buffer.from(file.base64, "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error(`El archivo ${label} está vacío o supera 8 MB.`);
  if (!isExcelBuffer(buffer, name)) throw new Error(`El archivo ${label} no tiene una firma Excel válida.`);
  return {
    name,
    mimeType: /\.xls$/i.test(name) ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer
  };
}

function isExcelBuffer(buffer, name) {
  if (/\.xlsx$/i.test(name)) return buffer[0] === 0x50 && buffer[1] === 0x4b;
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return ole.every((byte, index) => buffer[index] === byte);
}

async function uploadFile(supabase, path, file) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
    contentType: file.mimeType,
    cacheControl: "3600",
    upsert: false
  });
  if (error) throw new Error(`No fue posible almacenar ${file.name}: ${error.message}`);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeFileName(value) {
  const cleaned = String(value || "archivo.xlsx")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return cleaned || "archivo.xlsx";
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

module.exports._test = { validateAndReconcile, decodeExcelFile, safeFileName };
