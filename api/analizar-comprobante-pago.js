/*
 * VALEPAC · Analizador de comprobantes de pago Copec
 * Vercel Serverless Function
 * Requiere en Vercel: GEMINI_API_KEY
 * Opcional: GEMINI_MODEL (por defecto gemini-2.5-flash)
 */

const MAX_PDF_BYTES = 4 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const fileName = String(body.fileName || "comprobante.pdf");
    const dataUrl = String(body.dataUrl || "");
    const match = dataUrl.match(/^data:application\/pdf;base64,(.+)$/i);

    if (!match) {
      return res.status(400).json({ error: "Debe enviar un PDF válido en dataUrl." });
    }

    const base64 = match[1];
    const estimatedBytes = Math.floor((base64.length * 3) / 4);
    if (estimatedBytes > MAX_PDF_BYTES) {
      return res.status(413).json({
        error: "El PDF supera 4 MB. Descarga o genera una versión más liviana antes de cargarla."
      });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const prompt = `
Analiza el comprobante PDF de pago o compensación de Copec llamado "${fileName}".
Extrae toda la información visible, incluyendo todas las filas de todas las páginas, sin resumir ni omitir movimientos.

Reglas obligatorias:
1. No inventes datos. Si un campo no aparece, usa una cadena vacía o cero según corresponda.
2. numero_transaccion debe conservarse exactamente como aparece en el comprobante.
3. fecha_ejecucion debe quedar en ISO 8601 con zona horaria de Chile, por ejemplo 2026-07-13T15:35:04-04:00.
4. Las fechas de movimientos deben quedar como YYYY-MM-DD.
5. Los valores deben ser enteros CLP con signo. Ejemplo: "$ -5.203.461" debe ser -5203461 y "$ 440.300" debe ser 440300.
6. Recorre la tabla completa página por página y conserva el mismo orden de las filas.
7. tipo_documento debe copiar el texto del comprobante, por ejemplo Factura, Nota de Crédito, Solicitud de Abono, Venta Tarjetas Mov, Abono por Recompra E, Consumo Muevo Empresas o Case Aplicado.
8. saldo_compensacion corresponde al total final indicado al pie del comprobante.
9. El arreglo movimientos debe contener una entrada por cada fila visible del comprobante.
`;

    const responseSchema = {
      type: "OBJECT",
      properties: {
        tipo_comprobante: { type: "STRING" },
        cliente: { type: "STRING" },
        direccion: { type: "STRING" },
        numero_transaccion: { type: "STRING" },
        fecha_ejecucion: { type: "STRING" },
        saldo_compensacion: { type: "NUMBER" },
        movimientos: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              fecha: { type: "STRING" },
              tipo_documento: { type: "STRING" },
              numero_documento: { type: "STRING" },
              valor: { type: "NUMBER" }
            },
            required: ["fecha", "tipo_documento", "numero_documento", "valor"]
          }
        }
      },
      required: ["tipo_comprobante", "cliente", "numero_transaccion", "fecha_ejecucion", "saldo_compensacion", "movimientos"]
    };

    const geminiResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "application/pdf", data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 16384,
          responseMimeType: "application/json",
          responseSchema
        }
      })
    });

    const raw = await geminiResponse.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (_) { payload = { raw }; }

    if (!geminiResponse.ok) {
      const message = payload?.error?.message || payload?.message || raw || "Error consultando Gemini.";
      return res.status(geminiResponse.status).json({ error: message });
    }

    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map(part => part?.text || "")
      .join("")
      .trim();

    if (!text) {
      return res.status(502).json({ error: "Gemini no devolvió información del comprobante." });
    }

    let extracted;
    try {
      extracted = JSON.parse(stripCodeFence(text));
    } catch (error) {
      return res.status(502).json({ error: `La respuesta de Gemini no era JSON válido: ${error.message}` });
    }

    const normalized = normalizeComprobante(extracted);
    if (!normalized.numero_transaccion) {
      return res.status(422).json({ error: "No se pudo identificar el N° de transacción del PDF." });
    }
    if (!normalized.movimientos.length) {
      return res.status(422).json({ error: "No se detectaron movimientos en el PDF." });
    }

    return res.status(200).json({ ok: true, data: normalized });
  } catch (error) {
    console.error("analizar-comprobante-pago", error);
    return res.status(500).json({ error: error.message || "Error procesando el comprobante." });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: "4mb" } }
};

function stripCodeFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeComprobante(source) {
  const rows = Array.isArray(source?.movimientos) ? source.movimientos : [];
  return {
    tipo_comprobante: cleanText(source?.tipo_comprobante),
    cliente: cleanText(source?.cliente),
    direccion: cleanText(source?.direccion),
    numero_transaccion: cleanDocument(source?.numero_transaccion || source?.numero_propuesta),
    fecha_ejecucion: normalizeDateTime(source?.fecha_ejecucion),
    saldo_compensacion: parseMoney(source?.saldo_compensacion),
    movimientos: rows.map((row, index) => ({
      orden: index + 1,
      fecha: normalizeDate(row?.fecha),
      tipo_documento: cleanText(row?.tipo_documento),
      numero_documento: cleanDocument(row?.numero_documento),
      valor: parseMoney(row?.valor)
    })).filter(row => row.tipo_documento || row.numero_documento || row.valor !== 0)
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanDocument(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return String(value).trim().replace(/\.0+$/, "");
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  let text = String(value ?? "").trim();
  if (!text) return 0;
  const negative = /-/.test(text) || /^\(.*\)$/.test(text);
  text = text.replace(/[^0-9,.-]/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d+(,\d+)$/.test(text)) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");
  const number = Number(text.replace(/-/g, ""));
  if (!Number.isFinite(number)) return 0;
  return Math.round(negative ? -number : number);
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return "";
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (match) return `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  return "";
}

function normalizeDateTime(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    return /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}-04:00`;
  }
  const match = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}).*?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return `${match[3]}-${pad(match[2])}-${pad(match[1])}T${pad(match[4])}:${pad(match[5])}:${pad(match[6] || 0)}-04:00`;
  }
  const date = normalizeDate(text);
  return date ? `${date}T12:00:00-04:00` : "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}
