const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const CORE = require("../conciliacion-bancaria/reconciliation-core.js");

const BUCKET = "conciliaciones-bancarias";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 10000;
const MAX_LEDGER_ROWS = 50000;
const PAGE_SIZE = 1000;

async function handler(req, res) {
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

  if (req.method === "GET") return getLedger(supabase, req, res);
  return addToLedger(supabase, req, res);
}

handler.config = { api: { bodyParser: { sizeLimit: "20mb" } } };
module.exports = handler;

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

async function getLedger(supabase, req, res) {
  const windowMinutes = clampWindow(getQueryValue(req.query?.window));
  try {
    const [maeData, bciData, uploadsResult] = await Promise.all([
      fetchAllRows((from, to) => supabase
        .from("conciliacion_mae_flujo")
        .select("registro_id,source_key_original,source_row,occurred_at,maquina,cliente,usuario,tipo,moneda,monto")
        .order("occurred_at", { ascending: true })
        .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from("conciliacion_bci_flujo")
        .select("registro_id,source_key_original,source_row,occurred_at,fecha_contable,codigo_transaccion,tipo,glosa,monto,en_alcance,motivo_exclusion")
        .order("occurred_at", { ascending: true })
        .range(from, to)),
      supabase
        .from("conciliacion_flujo_cargas")
        .select("id,created_at,creado_por,fuente,mae_archivo_nombre,bci_archivo_nombre,mae_recibidos,mae_nuevos,bci_recibidos,bci_nuevos")
        .order("created_at", { ascending: false })
        .limit(100)
    ]);

    if (uploadsResult.error) throw uploadsResult.error;
    const maeRows = maeData.map(toCoreMae);
    const bciRows = bciData.map(toCoreBci);
    const result = CORE.reconcile(
      { deposits: maeRows },
      { inScope: bciRows.filter(row => row.inScope), excluded: bciRows.filter(row => !row.inScope) },
      { windowMinutes }
    );

    return res.status(200).json({
      result: compactResult(result),
      uploads: uploadsResult.data || [],
      updatedAt: uploadsResult.data?.[0]?.created_at || null
    });
  } catch (error) {
    const missingSchema = /conciliacion_(mae_flujo|bci_flujo|flujo_cargas)|does not exist|schema cache/i.test(error.message || "");
    return res.status(503).json({
      error: missingSchema
        ? "Supabase está conectado, pero falta ejecutar la migración del flujo histórico continuo."
        : (error.message || "No fue posible consultar la conciliación histórica.")
    });
  }
}

function compactResult(result) {
  return {
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    windowMinutes: result.windowMinutes,
    summary: result.summary,
    rows: result.rows.map(row => ({
      statusKey: row.statusKey,
      statusLabel: row.statusLabel,
      amount: row.amount,
      deltaSeconds: row.deltaSeconds,
      crossesDay: row.crossesDay,
      mae: row.mae ? {
        dateTime: row.mae.dateTime,
        dateKey: row.mae.dateKey,
        user: row.mae.user,
        machine: row.mae.machine,
        amount: row.mae.amount
      } : null,
      bci: row.bci ? {
        dateTime: row.bci.dateTime,
        dateKey: row.bci.dateKey,
        detail: row.bci.detail,
        transactionCode: row.bci.transactionCode,
        amount: row.bci.amount
      } : null
    }))
  };
}

async function addToLedger(supabase, req, res) {
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    return res.status(400).json({ error: "El contenido enviado no es JSON válido." });
  }

  let prepared;
  let maeFile = null;
  let bciFile = null;
  try {
    prepared = validateAndPrepareFlow(body);
    if (prepared.mae.length) maeFile = decodeExcelFile(body.files?.mae, "MAE");
    if (prepared.bci.length) bciFile = decodeExcelFile(body.files?.bci, "BCI");
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const uploadId = crypto.randomUUID();
  const uploadedPaths = [];
  try {
    const maePath = maeFile ? `${uploadId}/mae_${safeFileName(maeFile.name)}` : null;
    const bciPath = bciFile ? `${uploadId}/bci_${safeFileName(bciFile.name)}` : null;
    if (maeFile) {
      await uploadFile(supabase, maePath, maeFile);
      uploadedPaths.push(maePath);
    }
    if (bciFile) {
      await uploadFile(supabase, bciPath, bciFile);
      uploadedPaths.push(bciPath);
    }

    prepared.carga = {
      id: uploadId,
      creado_por: cleanText(body.carga?.creado_por || "Usuario portal", 150),
      fuente: maeFile && bciFile ? "ambas" : maeFile ? "mae" : "bci",
      mae_archivo_nombre: maeFile?.name || null,
      mae_archivo_sha256: maeFile ? sha256(maeFile.buffer) : null,
      mae_storage_path: maePath,
      bci_archivo_nombre: bciFile?.name || null,
      bci_archivo_sha256: bciFile ? sha256(bciFile.buffer) : null,
      bci_storage_path: bciPath
    };

    const { data, error } = await supabase.rpc("alimentar_conciliacion_bancaria", { p_payload: prepared });
    if (error) throw new Error(error.message || "No fue posible incorporar los movimientos en Supabase.");

    return res.status(201).json({
      id: uploadId,
      counts: data || {},
      message: "Movimientos incorporados al historial único."
    });
  } catch (error) {
    if (uploadedPaths.length) {
      try { await supabase.storage.from(BUCKET).remove(uploadedPaths); } catch (_) {}
    }
    return res.status(500).json({ error: error.message || "No fue posible actualizar la conciliación histórica." });
  }
}

function validateAndPrepareFlow(body) {
  if (!body || typeof body !== "object") throw new Error("Falta la carga de movimientos.");
  const maeInput = Array.isArray(body.mae) ? body.mae : [];
  const bciInput = Array.isArray(body.bci) ? body.bci : [];
  if (!maeInput.length && !bciInput.length) throw new Error("Carga al menos un archivo MAE o BCI con movimientos válidos.");
  if (maeInput.length > MAX_ROWS_PER_FILE || bciInput.length > MAX_ROWS_PER_FILE) {
    throw new Error(`La carga supera el máximo de ${MAX_ROWS_PER_FILE} movimientos por archivo.`);
  }

  const maeRows = maeInput.map((row, index) => normalizeMaeRow(row, index));
  const bciRows = bciInput.map((row, index) => normalizeBciRow(row, index));
  ensureUnique(maeRows, "sourceKey", "El archivo MAE contiene claves duplicadas.");
  ensureUnique(bciRows, "sourceKey", "La cartola BCI contiene códigos de transacción duplicados.");

  return {
    carga: {},
    mae: addStableIds(maeRows, "mae").map(row => ({
      registro_id: row.registroId, source_key_original: row.sourceKey, source_row: row.sourceRow,
      occurred_at: row.dateTime, maquina: row.machine, cliente: row.client, usuario: row.user,
      tipo: row.type, moneda: row.currency, monto: row.amount
    })),
    bci: addStableIds(bciRows, "bci").map(row => ({
      registro_id: row.registroId, source_key_original: row.sourceKey, source_row: row.sourceRow,
      occurred_at: row.dateTime, fecha_contable: row.accountingDate || null,
      codigo_transaccion: row.transactionCode, tipo: row.type, glosa: row.detail,
      monto: row.amount, en_alcance: row.inScope, motivo_exclusion: row.excludedReason || null
    }))
  };
}

function addStableIds(rows, kind) {
  const occurrences = new Map();
  return rows.map(row => {
    const base = kind === "bci" && row.transactionCode
      ? `bci|codigo|${identityText(row.transactionCode)}`
      : kind === "mae"
        ? ["mae", row.dateTime, row.amount, row.machine, row.client, row.user, row.type, row.currency].map(identityText).join("|")
        : ["bci", "datos", row.dateTime, row.amount, row.type, row.detail].map(identityText).join("|");
    const occurrence = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, occurrence);
    return Object.assign({}, row, { registroId: sha256Text(`${base}|${occurrence}`) });
  });
}

function normalizeMaeRow(row, index) {
  const timestamp = CORE.parseDateTime(row?.occurred_at);
  const amount = positiveInteger(row?.monto, `Importe MAE inválido en la fila ${index + 1}.`);
  if (!timestamp) throw new Error(`Fecha MAE inválida en la fila ${index + 1}.`);
  return {
    sourceKey: cleanText(row.source_key || `MAE-${index + 1}`, 500), sourceRow: positiveRow(row.source_row, index),
    dateTime: timestamp.dateTime, dateKey: timestamp.dateKey, epoch: timestamp.epoch,
    machine: cleanText(row.maquina, 250), client: cleanText(row.cliente, 250), user: cleanText(row.usuario, 250),
    type: cleanText(row.tipo || "Depósito", 100), currency: cleanText(row.moneda || "CLP", 20), amount
  };
}

function normalizeBciRow(row, index) {
  const timestamp = CORE.parseDateTime(row?.occurred_at);
  const amount = positiveInteger(row?.monto, `Importe BCI inválido en la fila ${index + 1}.`);
  if (!timestamp) throw new Error(`Fecha BCI inválida en la fila ${index + 1}.`);
  const accounting = row?.fecha_contable ? CORE.parseDateTime(row.fecha_contable) : null;
  return {
    sourceKey: cleanText(row.source_key || row.codigo_transaccion || `BCI-${index + 1}`, 500), sourceRow: positiveRow(row.source_row, index),
    dateTime: timestamp.dateTime, dateKey: timestamp.dateKey, epoch: timestamp.epoch,
    accountingDate: accounting?.dateKey || "", transactionCode: cleanText(row.codigo_transaccion, 500),
    type: cleanText(row.tipo || "DEPOSITOS", 100), detail: cleanText(row.glosa, 500), amount,
    inScope: row.en_alcance === true, excludedReason: cleanText(row.motivo_exclusion, 200)
  };
}

function toCoreMae(row) {
  const timestamp = CORE.parseDateTime(row.occurred_at);
  return {
    sourceKey: row.registro_id, sourceRow: Number(row.source_row || 0),
    dateTime: timestamp?.dateTime || String(row.occurred_at || ""), dateKey: timestamp?.dateKey || "", epoch: timestamp?.epoch || 0,
    machine: row.maquina || "", client: row.cliente || "", user: row.usuario || "",
    type: row.tipo || "Depósito", currency: row.moneda || "CLP", amount: Number(row.monto || 0)
  };
}

function toCoreBci(row) {
  const timestamp = CORE.parseDateTime(row.occurred_at);
  return {
    sourceKey: row.registro_id, sourceRow: Number(row.source_row || 0),
    dateTime: timestamp?.dateTime || String(row.occurred_at || ""), dateKey: timestamp?.dateKey || "", epoch: timestamp?.epoch || 0,
    accountingDate: row.fecha_contable || "", transactionCode: row.codigo_transaccion || "",
    type: row.tipo || "DEPOSITOS", detail: row.glosa || "", amount: Number(row.monto || 0),
    inScope: row.en_alcance === true, excludedReason: row.motivo_exclusion || ""
  };
}

async function fetchAllRows(buildPage) {
  const rows = [];
  for (let from = 0; from < MAX_LEDGER_ROWS; from += PAGE_SIZE) {
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw new Error(`El historial supera ${MAX_LEDGER_ROWS.toLocaleString("es-CL")} movimientos por fuente.`);
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
    contentType: file.mimeType, cacheControl: "3600", upsert: false
  });
  if (error) throw new Error(`No fue posible almacenar ${file.name}: ${error.message}`);
}

function clampWindow(value) {
  const number = Number(value || 180);
  return Math.max(1, Math.min(1440, Number.isFinite(number) ? number : 180));
}

function getQueryValue(value) {
  return String(Array.isArray(value) ? value[0] : (value || "")).trim();
}

function identityText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeFileName(value) {
  const cleaned = String(value || "archivo.xlsx").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned || "archivo.xlsx";
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

module.exports._test = {
  validateAndPrepareFlow, addStableIds, normalizeMaeRow, normalizeBciRow,
  decodeExcelFile, safeFileName, getQueryValue, identityText, clampWindow, compactResult
};
