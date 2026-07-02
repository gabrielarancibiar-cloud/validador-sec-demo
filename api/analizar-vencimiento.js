module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

function extractGeminiText(payload) {
  try {
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || '').join('\n').trim();
  } catch (_) {
    return '';
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const clean = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try { return JSON.parse(clean); } catch (_) {}
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

function normalizeResult(result) {
  const out = result && typeof result === 'object' ? result : {};
  const fecha = typeof out.fecha_vencimiento === 'string' ? out.fecha_vencimiento.trim() : null;
  const iso = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null;
  const confianza = String(out.confianza || '').toLowerCase();

  return {
    fecha_vencimiento: iso,
    tipo_documento_detectado: typeof out.tipo_documento_detectado === 'string' ? out.tipo_documento_detectado : '',
    confianza: ['alta', 'media', 'baja'].includes(confianza) ? confianza : 'baja',
    fundamento: typeof out.fundamento === 'string'
      ? out.fundamento.slice(0, 700)
      : 'Resultado generado por análisis asistido. Revisa antes de guardar.',
    fechas_encontradas: Array.isArray(out.fechas_encontradas)
      ? out.fechas_encontradas.slice(0, 8).map(f => ({
          fecha: typeof f.fecha === 'string' ? f.fecha : '',
          texto: typeof f.texto === 'string' ? f.texto.slice(0, 180) : ''
        }))
      : []
  };
}

function dataUrlToGeminiInlineData(dataUrl, mimeType) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: mimeType || match[1] || 'application/octet-stream',
    data: match[2]
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel.' });
    }

    const { fileName, mimeType, dataUrl, tipoDocumento, patente } = req.body || {};
    if (!fileName || !dataUrl) {
      return res.status(400).json({ error: 'Falta archivo para analizar.' });
    }

    if (String(dataUrl).length > 11_000_000) {
      return res.status(413).json({ error: 'Archivo muy pesado para análisis IA. Usa archivo menor a 8 MB.' });
    }

    const inlineData = dataUrlToGeminiInlineData(dataUrl, mimeType);
    if (!inlineData) {
      return res.status(400).json({ error: 'Formato de archivo no válido para análisis IA.' });
    }

    const instructions = `Eres un asistente documental para una estación de servicio en Chile. Analiza el archivo cargado y detecta la fecha de vencimiento más probable del documento vehicular.

Documento esperado: ${tipoDocumento || 'no indicado'}.
Patente asociada: ${patente || 'no indicada'}.
Nombre del archivo: ${fileName || 'sin nombre'}.

Reglas estrictas:
- Devuelve SOLO JSON válido, sin markdown ni texto adicional.
- Usa fecha_vencimiento en formato ISO YYYY-MM-DD.
- Busca vencimiento, vigencia hasta, válido hasta, fecha término, próxima revisión, fecha de recarga o fecha de vencimiento según el tipo de documento.
- No confundas fecha de emisión, fecha de pago, fecha de impresión, fecha de creación ni fecha de inicio con vencimiento.
- Si hay varias fechas, prioriza la que indique vigencia final/vencimiento del documento esperado.
- Si el documento esperado es Permiso de circulación, prioriza fecha de vencimiento o vigencia final del permiso.
- Si el documento esperado es Revisión técnica, prioriza fecha de vencimiento de revisión técnica o próxima revisión.
- Si el documento esperado es Seguro SOAP, prioriza fecha de término de vigencia del seguro.
- Si el documento esperado es Vencimiento extintor, prioriza fecha de vencimiento, recarga o próxima mantención.
- Si no existe certeza razonable, fecha_vencimiento debe ser null y confianza baja.

JSON requerido:
{
  "fecha_vencimiento": "YYYY-MM-DD o null",
  "tipo_documento_detectado": "texto breve",
  "confianza": "alta | media | baja",
  "fundamento": "explicación breve de por qué esa fecha corresponde al vencimiento",
  "fechas_encontradas": [
    {"fecha":"YYYY-MM-DD", "texto":"fragmento o referencia donde apareció"}
  ]
}`;

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: instructions },
              { inlineData }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        }
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const msg = payload?.error?.message || 'Error del servicio IA Gemini.';
      return res.status(response.status).json({ error: msg });
    }

    const text = extractGeminiText(payload);
    const parsed = safeJsonParse(text);
    return res.status(200).json(normalizeResult(parsed));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error interno analizando el archivo con Gemini.' });
  }
};
