module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

function extractOutputText(payload) {
  if (!payload) return '';
  if (typeof payload.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const c of item.content || []) {
      if (typeof c.text === 'string') parts.push(c.text);
      if (typeof c.output_text === 'string') parts.push(c.output_text);
    }
  }
  return parts.join('\n');
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

function normalizeResult(result) {
  const out = result && typeof result === 'object' ? result : {};
  const fecha = typeof out.fecha_vencimiento === 'string' ? out.fecha_vencimiento.trim() : null;
  const iso = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null;
  return {
    fecha_vencimiento: iso,
    tipo_documento_detectado: typeof out.tipo_documento_detectado === 'string' ? out.tipo_documento_detectado : '',
    confianza: ['alta', 'media', 'baja'].includes(String(out.confianza || '').toLowerCase()) ? String(out.confianza).toLowerCase() : 'baja',
    fundamento: typeof out.fundamento === 'string' ? out.fundamento.slice(0, 700) : 'Resultado generado por análisis asistido. Revisa antes de guardar.',
    fechas_encontradas: Array.isArray(out.fechas_encontradas) ? out.fechas_encontradas.slice(0, 8).map(f => ({
      fecha: typeof f.fecha === 'string' ? f.fecha : '',
      texto: typeof f.texto === 'string' ? f.texto.slice(0, 180) : ''
    })) : []
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Falta configurar OPENAI_API_KEY en Vercel.' });
    }

    const { fileName, mimeType, dataUrl, tipoDocumento, patente } = req.body || {};
    if (!fileName || !dataUrl) {
      return res.status(400).json({ error: 'Falta archivo para analizar.' });
    }
    if (String(dataUrl).length > 11_000_000) {
      return res.status(413).json({ error: 'Archivo muy pesado para análisis IA. Usa archivo menor a 8 MB.' });
    }

    const mt = mimeType || 'application/octet-stream';
    const isImage = String(mt).startsWith('image/');
    const fileBlock = isImage
      ? { type: 'input_image', image_url: dataUrl }
      : { type: 'input_file', filename: fileName, file_data: dataUrl };

    const instructions = `Eres un asistente documental para una estación de servicio en Chile. Analiza el archivo cargado y detecta la fecha de vencimiento más probable del documento vehicular. Documento esperado: ${tipoDocumento || 'no indicado'}. Patente asociada: ${patente || 'no indicada'}.

Reglas estrictas:
- Devuelve SOLO JSON válido, sin markdown ni texto adicional.
- Usa fecha_vencimiento en formato ISO YYYY-MM-DD.
- Busca vencimiento, vigencia hasta, válido hasta, fecha término, próxima revisión, fecha de recarga o fecha de vencimiento según el tipo de documento.
- No confundas fecha de emisión, fecha de pago, fecha de impresión, fecha de creación ni fecha de inicio con vencimiento.
- Si hay varias fechas, prioriza la que indique vigencia final/vencimiento del documento esperado.
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

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: instructions },
              fileBlock
            ]
          }
        ],
        text: { format: { type: 'json_object' } },
        temperature: 0
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const msg = payload?.error?.message || 'Error del servicio IA.';
      return res.status(response.status).json({ error: msg });
    }

    const text = extractOutputText(payload);
    const parsed = safeJsonParse(text);
    return res.status(200).json(normalizeResult(parsed));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error interno analizando el archivo.' });
  }
};
