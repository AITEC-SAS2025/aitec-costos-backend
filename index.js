// index.js (ESM) - Backend Costos AITEC (Render)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pdfParse from "pdf-parse";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "35mb" })); // base64 pdf puede ser pesado, pero OJO: no te excedas

const PORT = process.env.PORT || 10000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openaiConfigured = Boolean(OPENAI_API_KEY && OPENAI_API_KEY.trim().length > 10);
const client = openaiConfigured ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// límites
const MAX_BASE64_BYTES = 12 * 1024 * 1024; // ~12MB binario real (base64 será mayor). Ajusta si necesitas.
const MAX_TEXT_CHARS = 140_000; // texto total para IA

// "DB" en memoria (simple)
let MATERIALS = [];
let PROFESSIONALS = [];
let COSTINGS = [];

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function nowISO() {
  return new Date().toISOString();
}
function clampNumber(n, min, max, fallback = 0) {
  const x = Number(n);
  if (Number.isNaN(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}
function money(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.round(x);
}

function computeTotals({ professionals = [], materials = [], params = {} }) {
  const factorPrestacional = clampNumber(params.factorPrestacional ?? 1.58, 1.0, 3.0, 1.58);
  const imprevistosPct = clampNumber(params.imprevistosPct ?? 5, 0, 40, 5);
  const margenPct = clampNumber(params.margenPct ?? 30, 0, 80, 30);

  const subtotalProfesionales = professionals.reduce((acc, p) => {
    const qty = clampNumber(p.quantity ?? 0, 0, 1e9, 0);
    const months = clampNumber(p.months ?? 0, 0, 1e9, 0);
    const dedication = clampNumber(p.dedication ?? 1, 0, 2, 1);
    const monthly = clampNumber(p.monthlyValue ?? 0, 0, 1e12, 0);
    return acc + (qty * months * dedication * monthly * factorPrestacional);
  }, 0);

  const subtotalMateriales = materials.reduce((acc, m) => {
    const qty = clampNumber(m.quantity ?? 0, 0, 1e12, 0);
    const unitPrice = clampNumber(m.unitPrice ?? 0, 0, 1e12, 0);
    return acc + qty * unitPrice;
  }, 0);

  const subtotalProduccion = subtotalProfesionales + subtotalMateriales;
  const imprevistos = subtotalProduccion * (imprevistosPct / 100);
  const totalProduccion = subtotalProduccion + imprevistos;

  const ofertaSugerida = margenPct >= 100 ? null : (totalProduccion / (1 - (margenPct / 100)));

  const presupuestoFijo =
    params.presupuestoFijo != null && params.presupuestoFijo !== ""
      ? clampNumber(params.presupuestoFijo, 0, 1e15, 0)
      : null;

  let margenPosible = null;
  if (presupuestoFijo && presupuestoFijo > 0) {
    margenPosible = ((presupuestoFijo - totalProduccion) / presupuestoFijo) * 100;
  }

  return {
    factorPrestacional,
    imprevistosPct,
    margenPct,
    presupuestoFijo,
    subtotalProfesionales: money(subtotalProfesionales),
    subtotalMateriales: money(subtotalMateriales),
    subtotalProduccion: money(subtotalProduccion),
    imprevistos: money(imprevistos),
    totalProduccion: money(totalProduccion),
    ofertaSugerida: ofertaSugerida == null ? null : money(ofertaSugerida),
    margenPosible: margenPosible == null ? null : Math.round(margenPosible * 100) / 100
  };
}

// -------- Root / Health --------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "API de Costos AITEC funcionando correctamente 🚀",
    docs: {
      health: "/health",
      filesToText: "POST /files/toText",
      aiCosteo: "POST /ai/costeo"
    },
    openaiConfigured
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: nowISO(), openaiConfigured });
});

// --------- PDF -> TEXTO ---------
// Recibe JSON: { filename, mime, base64 }
// base64 puede venir como data:application/pdf;base64,.... o solo "...."
app.post("/files/toText", async (req, res) => {
  try {
    const { filename = "document.pdf", mime = "application/pdf", base64 = "" } = req.body || {};

    if (!base64 || typeof base64 !== "string") {
      return res.status(400).json({ error: "Falta base64 del archivo." });
    }

    if (!mime.includes("pdf")) {
      return res.status(400).json({ error: "Solo se soporta PDF en /files/toText por ahora." });
    }

    // limpiar prefijo data:
    const cleaned = base64.includes("base64,") ? base64.split("base64,")[1] : base64;

    // estimar tamaño binario real
    const approxBytes = Math.floor((cleaned.length * 3) / 4);
    if (approxBytes > MAX_BASE64_BYTES) {
      return res.status(413).json({
        error: "PDF demasiado grande.",
        detail: `Máximo aprox ${MAX_BASE64_BYTES} bytes. Reduce el PDF o divídelo.`,
        approxBytes
      });
    }

    const buffer = Buffer.from(cleaned, "base64");
    const parsed = await pdfParse(buffer);

    let text = (parsed?.text || "").trim();
    if (!text) {
      return res.status(422).json({
        error: "No se pudo extraer texto del PDF (puede ser escaneado/imagen).",
        hint: "Si es un PDF escaneado, necesitas OCR (otra ruta)."
      });
    }

    // recortar si es gigantesco
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
    }

    res.json({
      status: "ok",
      filename,
      chars: text.length,
      text
    });
  } catch (err) {
    res.status(500).json({ error: "Error extrayendo texto del PDF.", detail: err?.message || String(err) });
  }
});

// -------- IA: costeo --------
const COST_SCHEMA = {
  name: "cost_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assumptions: { type: "array", items: { type: "string" } },
      professionals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string" },
            profile: { type: "string" },
            quantity: { type: "number" },
            dedication: { type: "number" },
            months: { type: "number" },
            monthlyValue: { type: "number" },
            justification: { type: "string" }
          },
          required: ["role", "quantity", "dedication", "months", "monthlyValue"]
        }
      },
      materials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            unit: { type: "string" },
            quantity: { type: "number" },
            unitPrice: { type: "number" },
            justification: { type: "string" }
          },
          required: ["name", "quantity", "unitPrice"]
        }
      }
    },
    required: ["professionals", "materials", "assumptions"]
  }
};

app.post("/ai/costeo", async (req, res) => {
  try {
    if (!openaiConfigured || !client) {
      return res.status(503).json({
        error: "OpenAI no está configurado (falta OPENAI_API_KEY en Render)."
      });
    }

    const {
      objectText = "",
      metodologiaText = "",
      tdrText = "",
      notes = "",
      params = {}
    } = req.body || {};

    const combined = `${objectText}\n\n${metodologiaText}\n\n${tdrText}\n\n${notes}`;
    if (combined.length > MAX_TEXT_CHARS) {
      return res.status(413).json({
        error: "Texto demasiado grande para IA.",
        detail: "Reduce el texto o pega solo lo necesario.",
        receivedChars: combined.length,
        maxChars: MAX_TEXT_CHARS
      });
    }

    const factorPrestacional = clampNumber(params.factorPrestacional ?? 1.58, 1.0, 3.0, 1.58);
    const imprevistosPct = clampNumber(params.imprevistosPct ?? 5, 0, 40, 5);
    const margenPct = clampNumber(params.margenPct ?? 30, 0, 80, 30);

    const prompt = `
Eres un analista senior de costos en consultoría ambiental en Colombia.
A partir del OBJETO, METODOLOGÍA y TDR, propón:
1) Profesionales: rol, cantidad, dedicación (1.0=100%), meses, valor mensual, justificación.
2) Materiales: nombre, unidad, cantidad, precio unitario, justificación.
Usa estos parámetros:
- Factor prestacional: ${factorPrestacional} (aplica a profesionales)
- Imprevistos %: ${imprevistosPct}
- Margen %: ${margenPct}
Devuelve SOLO JSON válido del schema, sin texto adicional.

OBJETO:
${objectText}

METODOLOGÍA:
${metodologiaText}

TDR:
${tdrText}

NOTAS:
${notes}
`.trim();

    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          json_schema: COST_SCHEMA
        }
      }
    });

    const outputText = resp.output_text || "";
    let plan;
    try {
      plan = JSON.parse(outputText);
    } catch {
      return res.status(502).json({
        error: "La IA no devolvió JSON válido.",
        detail: outputText.slice(0, 2000)
      });
    }

    const professionals = (plan.professionals || []).map(p => ({
      role: String(p.role || ""),
      profile: String(p.profile || ""),
      quantity: clampNumber(p.quantity ?? 0, 0, 1e9, 0),
      dedication: clampNumber(p.dedication ?? 1, 0, 2, 1),
      months: clampNumber(p.months ?? 0, 0, 1e9, 0),
      monthlyValue: clampNumber(p.monthlyValue ?? 0, 0, 1e12, 0),
      justification: String(p.justification || "")
    }));

    const materials = (plan.materials || []).map(m => ({
      name: String(m.name || ""),
      unit: String(m.unit || ""),
      quantity: clampNumber(m.quantity ?? 0, 0, 1e12, 0),
      unitPrice: clampNumber(m.unitPrice ?? 0, 0, 1e12, 0),
      justification: String(m.justification || "")
    }));

    const totals = computeTotals({
      professionals,
      materials,
      params: { ...params, factorPrestacional, imprevistosPct, margenPct }
    });

    res.json({
      status: "ok",
      plan: {
        assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
        professionals,
        materials
      },
      totals
    });
  } catch (err) {
    const status = err?.status || 500;
    if (status === 429) {
      return res.status(429).json({
        error: "Límite alcanzado (429).",
        detail: "Es cuota/rate limit del proyecto OpenAI. Reintenta y/o revisa límites."
      });
    }
    if (status === 401) {
      return res.status(401).json({ error: "401 OpenAI: API Key inválida o sin permisos." });
    }
    res.status(500).json({ error: "Error en IA", detail: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto: ${PORT}`);
  console.log(`OpenAI configurado: ${openaiConfigured ? "SI" : "NO"}`);
});
