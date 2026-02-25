import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Render usa PORT dinámico
const PORT = process.env.PORT || 8787;

// OpenAI (IA)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================
// 1) Salud del servidor
// =====================
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "aitec-costos-backend" });
});

// ============================================
// 2) Búsqueda de materiales (MercadoLibre CO)
// ============================================
// Nota: esto es para "buscar en línea" sin API key.
// No es perfecto, pero funciona como MVP real.
app.get("/materials/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Falta parámetro q" });

    // MercadoLibre Colombia
    const url = `https://api.mercadolibre.com/sites/MCO/search?q=${encodeURIComponent(
      q
    )}&limit=12`;

    const r = await fetch(url);
    if (!r.ok) {
      return res.status(500).json({ error: "Error consultando MercadoLibre" });
    }
    const data = await r.json();

    const items =
      (data.results || []).map((it) => ({
        id: it.id,
        title: it.title,
        price: it.price,
        currency: it.currency_id,
        thumbnail: it.thumbnail,
        permalink: it.permalink,
        seller: it.seller?.nickname || null,
        condition: it.condition || null,
      })) || [];

    res.json({ query: q, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fallo en /materials/search" });
  }
});

// ===============================================
// 3) IA: Generar propuesta de profesionales/materiales
// ===============================================
// Entrada: metodología (texto), TDR (texto), notas (texto), contexto (objeto contrato)
// Salida: JSON con sugerencias de profesionales/materiales
app.post("/ai/plan", async (req, res) => {
  try {
    const { contractObject, methodologyText, tdrText, notes } = req.body || {};

    if (!tdrText || !methodologyText) {
      return res.status(400).json({
        error:
          "Faltan campos. Debes enviar methodologyText y tdrText (texto).",
      });
    }

    const system = `
Eres un asistente de costos de producción para licitaciones en Colombia.
Debes proponer:
1) Lista de profesionales (roles) con cantidad, meses, dedicación (%), factor prestacional sugerido (default 1.58) y un estimado de valor mensual (COP).
2) Lista de materiales (items) con cantidad, meses, valor mensual/unitario estimado (COP) y justificación corta.
Reglas:
- Responder SOLO JSON.
- Nada de texto adicional.
- Si algún valor no está claro, asume y agrega "assumptions".
- La dedicación en profesionales debe ser realista y rara vez 100%.
- Materiales: separar software/hardware/logística/viáticos/papelería.
- Valores: si no hay datos, estimar rangos razonables y dejar marcado como "estimated".
Formato:
{
  "assumptions": ["..."],
  "professionals": [
    {"role":"...", "qty":1, "months":6, "dedication":0.5, "factor":1.58, "monthly_cop": 8000000, "notes":"estimated|source|justification"}
  ],
  "materials": [
    {"item":"...", "category":"software|hardware|logistica|viaticos|papeleria|otros", "qty":1, "months":1, "monthly_or_unit_cop": 1200000, "pricing_type":"monthly|unit", "notes":"estimated|source|justification"}
  ]
}
`.trim();

    const user = `
OBJETO DEL CONTRATO:
${contractObject || "(no especificado)"}

METODOLOGÍA:
${methodologyText}

TÉRMINOS DE REFERENCIA (TDR):
${tdrText}

NOTAS DEL USUARIO (perfiles/alcance/condiciones):
${notes || "(sin notas)"}
`.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    const json = JSON.parse(content);

    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error:
        "Fallo en /ai/plan. Revisa logs. Asegura OPENAI_API_KEY en Render.",
    });
  }
});

app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto:", PORT);
});
