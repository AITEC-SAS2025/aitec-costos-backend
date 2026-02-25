// index.js (ESM) - Backend Costos AITEC (Render)
// Requiere: express, cors, dotenv, openai
// package.json debe tener: "type": "module"

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// -------------------- Config --------------------
app.use(cors());
app.use(express.json({ limit: "25mb" })); // ajusta si vas a enviar textos largos (NO base64 gigantes)

// Render usa PORT dinámico
const PORT = process.env.PORT || 10000;

// Si no está, la IA quedará deshabilitada (el resto funciona)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openaiConfigured = Boolean(OPENAI_API_KEY && OPENAI_API_KEY.trim().length > 10);

const client = openaiConfigured ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Límite de entrada para IA (evita que te manden PDFs en base64 sin querer)
const MAX_IA_INPUT_CHARS = 120_000; // ~120k caracteres (bastante texto). Base64 PDF suele ser MUCHO más.
const MAX_CATALOG_ITEMS = 5000;

// -------------------- In-memory DB (simple) --------------------
// Si quieres persistencia real: usar DB (Postgres/SQLite) o KV. Por ahora: memoria.
let MATERIALS = [];      // { id, name, unit, unitPrice, source, tags[] }
let PROFESSIONALS = [];  // { id, role, profile, monthlyRef, unit:"mes", source, tags[] }
let COSTINGS = [];       // { id, createdAt, updatedAt, title, objectText, params, professionals, materials, totals, notes, trace }

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeStr(s) {
  return (s || "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    const dedication = clampNumber(p.dedication ?? 1, 0, 2, 1); // 1=100%
    const monthly = clampNumber(p.monthlyValue ?? 0, 0, 1e12, 0);

    // costo base mensual * factor prestacional
    const base = qty * months * dedication * monthly * factorPrestacional;
    return acc + base;
  }, 0);

  const subtotalMateriales = materials.reduce((acc, m) => {
    const qty = clampNumber(m.quantity ?? 0, 0, 1e12, 0);
    const unitPrice = clampNumber(m.unitPrice ?? 0, 0, 1e12, 0);
    return acc + qty * unitPrice;
  }, 0);

  const subtotalProduccion = subtotalProfesionales + subtotalMateriales;
  const imprevistos = subtotalProduccion * (imprevistosPct / 100);
  const totalProduccion = subtotalProduccion + imprevistos;

  // Oferta sugerida: costo / (1 - margen)
  const ofertaSugerida = margenPct >= 100 ? null : (totalProduccion / (1 - (margenPct / 100)));

  const presupuestoFijo = params.presupuestoFijo != null && params.presupuestoFijo !== ""
    ? clampNumber(params.presupuestoFijo, 0, 1e15, 0)
    : null;

  // Si hay presupuesto fijo, se puede estimar margen posible:
  let margenPosible = null;
  if (presupuestoFijo && presupuestoFijo > 0) {
    margenPosible = (presupuestoFijo - totalProduccion) / presupuestoFijo * 100;
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

// -------------------- Routes --------------------

// Root: evita "Cannot GET /"
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "API de Costos AITEC funcionando correctamente 🚀",
    docs: {
      health: "/health",
      materialsLoad: "POST /materials/load",
      materialsSearch: "GET /materials/search?q=...&top=8",
      professionalsLoad: "POST /professionals/load",
      professionalsSearch: "GET /professionals/search?q=...&top=8",
      aiCosteo: "POST /ai/costeo",
      costingsSave: "POST /costings/save",
      costingsList: "GET /costings/list",
      costingsGet: "GET /costings/:id",
      costingsUpdate: "PUT /costings/:id",
      costingsDelete: "DELETE /costings/:id"
    },
    openaiConfigured
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: nowISO(), openaiConfigured });
});

// -------------------- Catalogs: Materials --------------------
app.post("/materials/load", (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items debe ser un array" });
  }
  if (items.length > MAX_CATALOG_ITEMS) {
    return res.status(400).json({ error: `Demasiados items. Máximo ${MAX_CATALOG_ITEMS}.` });
  }

  MATERIALS = items.map((x, idx) => ({
    id: x.id || uid("mat"),
    name: (x.name || "").toString(),
    unit: (x.unit || "").toString(),
    unitPrice: Number(x.unitPrice ?? x.price ?? 0) || 0,
    source: (x.source || "").toString(),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : []
  }));

  res.json({ status: "ok", count: MATERIALS.length });
});

app.get("/materials/search", (req, res) => {
  const q = (req.query.q || "").toString();
  const top = clampNumber(req.query.top ?? 8, 1, 50, 8);

  const nq = normalizeStr(q);
  if (!nq) return res.json({ items: [] });

  const items = MATERIALS
    .map((m) => {
      const hay = normalizeStr(`${m.name} ${m.unit} ${m.source} ${(m.tags || []).join(" ")}`);
      let score = 0;
      if (hay.includes(nq)) score += 5;
      // scoring por tokens
      nq.split(/\s+/).filter(Boolean).forEach(t => {
        if (t.length >= 3 && hay.includes(t)) score += 1;
      });
      return { ...m, _score: score };
    })
    .filter(x => x._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, top)
    .map(({ _score, ...rest }) => rest);

  res.json({ items });
});

// -------------------- Catalogs: Professionals --------------------
app.post("/professionals/load", (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items debe ser un array" });
  }
  if (items.length > MAX_CATALOG_ITEMS) {
    return res.status(400).json({ error: `Demasiados items. Máximo ${MAX_CATALOG_ITEMS}.` });
  }

  PROFESSIONALS = items.map((x) => ({
    id: x.id || uid("pro"),
    role: (x.role || x.name || "").toString(),
    profile: (x.profile || "").toString(),
    monthlyRef: Number(x.monthlyRef ?? x.monthly ?? x.value ?? 0) || 0,
    unit: (x.unit || "mes").toString(),
    source: (x.source || "").toString(),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : []
  }));

  res.json({ status: "ok", count: PROFESSIONALS.length });
});

app.get("/professionals/search", (req, res) => {
  const q = (req.query.q || "").toString();
  const top = clampNumber(req.query.top ?? 8, 1, 50, 8);

  const nq = normalizeStr(q);
  if (!nq) return res.json({ items: [] });

  const items = PROFESSIONALS
    .map((p) => {
      const hay = normalizeStr(`${p.role} ${p.profile} ${p.source} ${(p.tags || []).join(" ")}`);
      let score = 0;
      if (hay.includes(nq)) score += 5;
      nq.split(/\s+/).filter(Boolean).forEach(t => {
        if (t.length >= 3 && hay.includes(t)) score += 1;
      });
      return { ...p, _score: score };
    })
    .filter(x => x._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, top)
    .map(({ _score, ...rest }) => rest);

  res.json({ items });
});

// -------------------- Costings CRUD --------------------
app.post("/costings/save", (req, res) => {
  const payload = req.body || {};
  const id = uid("cost");
  const createdAt = nowISO();

  const record = {
    id,
    createdAt,
    updatedAt: createdAt,
    title: (payload.title || "Costo de producción").toString(),
    objectText: (payload.objectText || "").toString(),
    params: payload.params || {},
    professionals: Array.isArray(payload.professionals) ? payload.professionals : [],
    materials: Array.isArray(payload.materials) ? payload.materials : [],
    totals: payload.totals || computeTotals(payload),
    notes: payload.notes || {},
    trace: payload.trace || {}
  };

  COSTINGS.unshift(record);
  res.json({ status: "ok", id });
});

app.get("/costings/list", (req, res) => {
  const items = COSTINGS.map(c => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    totalProduccion: c.totals?.totalProduccion ?? 0,
    ofertaSugerida: c.totals?.ofertaSugerida ?? null
  }));
  res.json({ items });
});

app.get("/costings/:id", (req, res) => {
  const id = req.params.id;
  const found = COSTINGS.find(c => c.id === id);
  if (!found) return res.status(404).json({ error: "No existe ese costeo" });
  res.json({ item: found });
});

app.put("/costings/:id", (req, res) => {
  const id = req.params.id;
  const idx = COSTINGS.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "No existe ese costeo" });

  const payload = req.body || {};
  const updatedAt = nowISO();

  const merged = {
    ...COSTINGS[idx],
    ...payload,
    updatedAt,
  };

  // recalcular totales si vienen tablas o params
  const needRecalc =
    payload.params != null ||
    payload.professionals != null ||
    payload.materials != null;

  if (needRecalc) {
    merged.totals = computeTotals({
      professionals: Array.isArray(merged.professionals) ? merged.professionals : [],
      materials: Array.isArray(merged.materials) ? merged.materials : [],
      params: merged.params || {}
    });
  }

  COSTINGS[idx] = merged;
  res.json({ status: "ok" });
});

app.delete("/costings/:id", (req, res) => {
  const id = req.params.id;
  const before = COSTINGS.length;
  COSTINGS = COSTINGS.filter(c => c.id !== id);
  if (COSTINGS.length === before) return res.status(404).json({ error: "No existe ese costeo" });
  res.json({ status: "ok" });
});

// -------------------- IA: costeo --------------------
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
            dedication: { type: "number" },   // 1.0 = 100%
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
        error: "OpenAI no está configurado en el backend (falta OPENAI_API_KEY)."
      });
    }

    const {
      objectText = "",
      metodologiaText = "",
      tdrText = "",
      notes = "",
      params = {},
      // opcional: permitir que el frontend mande catálogos “en caliente”
      catalogs = null
    } = req.body || {};

    // Detectar base64 gigante (PDFs) y cortar por lo sano
    const combined = `${objectText}\n\n${metodologiaText}\n\n${tdrText}\n\n${notes}`;
    if (combined.length > MAX_IA_INPUT_CHARS) {
      return res.status(413).json({
        error: "El texto enviado es demasiado grande para IA.",
        detail:
          "No envíes PDFs como base64. Convierte a texto y pega el contenido (o reduce el documento).",
        receivedChars: combined.length,
        maxChars: MAX_IA_INPUT_CHARS
      });
    }

    // Catálogos disponibles
    const mats = catalogs?.materials && Array.isArray(catalogs.materials)
      ? catalogs.materials.slice(0, MAX_CATALOG_ITEMS)
      : MATERIALS;

    const pros = catalogs?.professionals && Array.isArray(catalogs.professionals)
      ? catalogs.professionals.slice(0, MAX_CATALOG_ITEMS)
      : PROFESSIONALS;

    // Para que la IA “ponga precios”, le damos referencias (top N para no inflar)
    // Consejo: si tus catálogos son enormes, lo correcto es hacer matching en backend,
    // pero por ahora lo dejamos simple.
    const matsCompact = mats.slice(0, 400).map(m => ({
      name: m.name,
      unit: m.unit,
      unitPrice: m.unitPrice
    }));

    const prosCompact = pros.slice(0, 300).map(p => ({
      role: p.role,
      monthlyRef: p.monthlyRef
    }));

    const factorPrestacional = clampNumber(params.factorPrestacional ?? 1.58, 1.0, 3.0, 1.58);
    const imprevistosPct = clampNumber(params.imprevistosPct ?? 5, 0, 40, 5);
    const margenPct = clampNumber(params.margenPct ?? 30, 0, 80, 30);

    const prompt = `
Eres un analista senior de costos en consultoría ambiental en Colombia.
Tu tarea: proponer una tabla de PROFESIONALES y MATERIALES a partir del OBJETO, METODOLOGÍA, TDR y NOTAS.
Debes incluir cantidades, dedicación (1.0=100%), meses y valor mensual para profesionales.
Para materiales: cantidades y valor unitario.
REGLA CLAVE: usa los valores unitarios/mensuales de los catálogos como referencia. Si no existe exacto, usa el más cercano y explica.
Devuelve SOLO JSON válido según el schema, sin texto adicional.

Parámetros financieros:
- Factor prestacional: ${factorPrestacional} (se aplica a costo de profesionales)
- Imprevistos %: ${imprevistosPct}
- Margen %: ${margenPct}

CATÁLOGO PROFESIONALES (referencia):
${JSON.stringify(prosCompact)}

CATÁLOGO MATERIALES (referencia):
${JSON.stringify(matsCompact)}

OBJETO DEL CONTRATO:
${objectText}

METODOLOGÍA:
${metodologiaText}

TDR / ALCANCE:
${tdrText}

NOTAS (duración, ciudad, restricciones, perfiles obligatorios, etc):
${notes}
`.trim();

    // Responses API (recomendada para proyectos nuevos)
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

    // Extraer JSON
    const outputText = resp.output_text || "";
    let plan;
    try {
      plan = JSON.parse(outputText);
    } catch (e) {
      return res.status(502).json({
        error: "La IA devolvió una respuesta que no es JSON válido.",
        detail: outputText.slice(0, 2000)
      });
    }

    // Normalizar números y calcular totales
    const professionals = (plan.professionals || []).map(p => ({
      role: (p.role || "").toString(),
      profile: (p.profile || "").toString(),
      quantity: clampNumber(p.quantity ?? 0, 0, 1e9, 0),
      dedication: clampNumber(p.dedication ?? 1, 0, 2, 1),
      months: clampNumber(p.months ?? 0, 0, 1e9, 0),
      monthlyValue: clampNumber(p.monthlyValue ?? 0, 0, 1e12, 0),
      justification: (p.justification || "").toString()
    }));

    const materials = (plan.materials || []).map(m => ({
      name: (m.name || "").toString(),
      unit: (m.unit || "").toString(),
      quantity: clampNumber(m.quantity ?? 0, 0, 1e12, 0),
      unitPrice: clampNumber(m.unitPrice ?? 0, 0, 1e12, 0),
      justification: (m.justification || "").toString()
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
    // Manejo de errores OpenAI típicos (429, 401, etc.)
    const status = err?.status || err?.response?.status || 500;
    const msg = err?.message || "Error desconocido";
    const detail = err?.response?.data || null;

    // 429 (rate limit / quota)
    if (status === 429) {
      return res.status(429).json({
        error: "Límite alcanzado (429).",
        detail:
          "Esto suele ser por cuota del proyecto/organización o rate limit. Intenta de nuevo en 30–60s, y revisa límites en OpenAI.",
        raw: msg
      });
    }

    // 401 (api key)
    if (status === 401) {
      return res.status(401).json({
        error: "No autorizado (401). Revisa OPENAI_API_KEY en Render.",
        raw: msg
      });
    }

    res.status(500).json({
      error: "Error en IA",
      detail: typeof detail === "string" ? detail : msg
    });
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto: ${PORT}`);
  console.log(`OpenAI configurado: ${openaiConfigured ? "SI" : "NO"}`);
});
