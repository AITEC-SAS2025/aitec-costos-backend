import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

/**
 * ============================
 *  OpenAI (NO tumbar servidor)
 * ============================
 */
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(); // puedes cambiarlo
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/**
 * ============================
 *  Almacenamiento (MVP en memoria)
 *  - En Render Free esto NO es persistente
 * ============================
 */
let PROFESSIONALS_DB = []; // [{ id, rol, perfil, experiencia_anios, salario_mensual, ... }]
let COSTINGS_DB = []; // [{ id, objectoContrato, createdAt, updatedAt, payload }]
let MATERIALS_DB = []; // opcional, si luego quieres cargar una base local

const uid = () =>
  "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);

const normalize = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();

/**
 * ============================
 *  Rutas básicas
 * ============================
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "API de Costos AITEC funcionando correctamente 🚀",
    docs: {
      health: "/health",
      aiCosteo: "POST /ai/costeo",
      materialsSearch: "GET /materials/search?q=...&top=8",
      professionalsLoad: "POST /professionals/load",
      professionalsSearch: "GET /professionals/search?q=...",
      costingsSave: "POST /costings/save",
      costingsList: "GET /costings/list",
      costingsGet: "GET /costings/:id",
      costingsUpdate: "PUT /costings/:id",
      costingsDelete: "DELETE /costings/:id",
    },
    openaiConfigured: Boolean(client),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "aitec-costos-backend",
    openaiConfigured: Boolean(client),
    time: new Date().toISOString(),
  });
});

/**
 * ============================
 *  Profesionales - cargar DB (MVP)
 *  BODY: { rows: [ {...}, {...} ] }
 * ============================
 */
app.post("/professionals/load", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!rows.length) {
    return res.status(400).json({
      error:
        "Debes enviar { rows: [...] } con al menos un registro de profesionales.",
    });
  }

  // Normaliza y asigna id si no trae
  PROFESSIONALS_DB = rows.map((r, idx) => ({
    id: r.id || `p_${idx + 1}`,
    rol: r.rol || r.cargo || r.perfil || "",
    perfil: r.perfil || r.descripcion || "",
    experiencia_anios:
      Number(r.experiencia_anios ?? r.experiencia ?? r.anios ?? 0) || 0,
    salario_mensual:
      Number(r.salario_mensual ?? r.valor_mensual ?? r.honorarios ?? 0) || 0,
    raw: r,
    _search:
      normalize(r.rol || r.cargo || r.perfil || "") +
      " " +
      normalize(r.perfil || r.descripcion || ""),
  }));

  res.json({
    ok: true,
    loaded: PROFESSIONALS_DB.length,
  });
});

/**
 * ============================
 *  Profesionales - buscar/matchear
 *  GET /professionals/search?q=ingeniero forestal...&top=10
 * ============================
 */
app.get("/professionals/search", (req, res) => {
  const q = normalize(req.query.q || "");
  const top = Math.min(Number(req.query.top || 10) || 10, 50);

  if (!q) {
    return res.json({ ok: true, results: [] });
  }

  // score simple por coincidencia de palabras
  const qTokens = q.split(/\s+/).filter(Boolean);

  const scored = PROFESSIONALS_DB.map((p) => {
    let score = 0;
    for (const t of qTokens) {
      if (p._search.includes(t)) score += 1;
    }
    return { p, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map(({ p, score }) => ({
      id: p.id,
      rol: p.rol,
      perfil: p.perfil,
      experiencia_anios: p.experiencia_anios,
      salario_mensual: p.salario_mensual,
      score,
      raw: p.raw,
    }));

  res.json({ ok: true, q: req.query.q, results: scored });
});

/**
 * ============================
 *  Materiales - búsqueda/sugerencia (MVP con IA)
 *  GET /materials/search?q=puntilla galvanizada&top=8
 *
 *  Nota: Sin un "API de precios" real, esto devuelve estimaciones con IA.
 *  Luego podemos integrar un proveedor real (MercadoLibre API / SerpAPI / etc).
 * ============================
 */
app.get("/materials/search", async (req, res) => {
  const qRaw = String(req.query.q || "").trim();
  const q = normalize(qRaw);
  const top = Math.min(Number(req.query.top || 8) || 8, 20);

  if (!qRaw) return res.json({ ok: true, results: [] });

  // 1) Si hay una base local cargada, intenta primero ahí
  const localMatches = MATERIALS_DB.filter((m) =>
    normalize(m.name || m.item || "").includes(q)
  )
    .slice(0, top)
    .map((m) => ({
      source: "local_db",
      name: m.name || m.item,
      unitPriceCOP: Number(m.unitPriceCOP || m.valor_unitario || 0) || 0,
      unit: m.unit || "und",
      notes: m.notes || "",
      raw: m,
    }));

  if (localMatches.length) {
    return res.json({ ok: true, q: qRaw, results: localMatches });
  }

  // 2) Si no hay OpenAI, devuelve guía
  if (!client) {
    return res.json({
      ok: true,
      q: qRaw,
      results: [],
      warning:
        "OPENAI_API_KEY no está configurada. Puedo buscar solo en base local; para estimaciones con IA, configura la API Key.",
    });
  }

  try {
    const prompt = `
Eres un asistente de compras para Colombia. 
El usuario busca un material/servicio: "${qRaw}".

Devuelve SOLO JSON estricto con un arreglo "results" de máximo ${top} opciones.
Cada opción debe tener:
- name (string)
- unit (string: und, caja, licencia/mes, día, km, etc.)
- unitPriceCOP (number)  (precio unitario estimado en COP)
- confidence (number 0..1)
- assumptions (string corto: marca/calidad/presentación estimada)
- recommendedQuery (string)  (una query mejorada para buscar en tiendas)

NO incluyas texto fuera del JSON.
`;

    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices?.[0]?.message?.content || "{}";
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // fallback si el modelo devolvió algo sucio
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      const cleaned = firstBrace >= 0 && lastBrace >= 0 ? text.slice(firstBrace, lastBrace + 1) : "{}";
      json = JSON.parse(cleaned);
    }

    const results = Array.isArray(json.results) ? json.results : [];
    const safe = results.slice(0, top).map((r) => ({
      source: "ai_estimate",
      name: String(r.name || qRaw),
      unit: String(r.unit || "und"),
      unitPriceCOP: Number(r.unitPriceCOP || 0) || 0,
      confidence: Math.max(0, Math.min(1, Number(r.confidence || 0.4) || 0.4)),
      assumptions: String(r.assumptions || "Estimación referencial; validar proveedor."),
      recommendedQuery: String(r.recommendedQuery || qRaw),
    }));

    res.json({
      ok: true,
      q: qRaw,
      results: safe,
      disclaimer:
        "Estos valores son estimaciones con IA. Valida precios reales antes de cerrar oferta.",
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Error generando sugerencias de materiales con IA.",
      details: String(err?.message || err),
    });
  }
});

/**
 * ============================
 *  IA - Generar costeo preliminar
 *  POST /ai/costeo
 *
 *  BODY esperado (ejemplo):
 *  {
 *    objectoContrato: "Interventoría ...",
 *    metodologia: "texto...",
 *    tdr: "texto...",
 *    notas: "cosas clave (tiempo, dedicación, etc)",
 *    factorPrestacional: 1.58,
 *    meses: 6,
 *    targetUtilidadPct: 0.30,
 *    imprevistosPct: 0.05
 *  }
 *
 *  Respuesta: JSON con professionals[], materials[], assumptions[]
 * ============================
 */
app.post("/ai/costeo", async (req, res) => {
  if (!client) {
    return res.status(400).json({
      ok: false,
      error:
        "OPENAI_API_KEY no configurada en Render. Configúrala para usar /ai/costeo.",
    });
  }

  const {
    objectoContrato = "",
    metodologia = "",
    tdr = "",
    notas = "",
    factorPrestacional = 1.58,
    meses = 6,
    targetUtilidadPct = 0.3,
    imprevistosPct = 0.05,
  } = req.body || {};

  // ayuda al modelo: muestra si hay base interna cargada
  const profCount = PROFESSIONALS_DB.length;

  const prompt = `
Eres un analista de costos de producción para propuestas en Colombia.

OBJETO DEL CONTRATO:
${objectoContrato}

METODOLOGÍA (del proceso):
${metodologia}

TÉRMINOS DE REFERENCIA / TDR:
${tdr}

NOTAS / DATOS DADOS POR EL USUARIO:
${notas}

REGLAS DE COSTEO:
- Profesionales: cantidad * meses * dedicación (0..1) * factorPrestacional * valorMensual
- Optimización profesionales: si dedicación < 1.0 entonces ahorro = (operaciónTotal - (cantidad * meses * dedicación * valorMensual))  (equivale a restar el factor prestacional)
- Materiales: cantidad * mesesUso * valorMensual (si compra única, mesesUso=1)
- Pareto materiales: ordenar desc por total, calcular % y acumulado

Parámetros:
- factorPrestacional = ${Number(factorPrestacional)}
- meses = ${Number(meses)}
- targetUtilidadPct = ${Number(targetUtilidadPct)}
- imprevistosPct = ${Number(imprevistosPct)}

Base interna de profesionales cargada: ${profCount} registros.
Si no hay base o no alcanza, propone valores mensuales estimados razonables en COP y marca "estimated": true.

Devuelve SOLO JSON estricto con esta forma:

{
  "assumptions": [string, ...],
  "professionals": [
    {
      "role": string,
      "qty": number,
      "months": number,
      "dedication": number,
      "factorPrestacional": number,
      "monthlyCOP": number,
      "estimated": boolean,
      "formulaTotalCOP": number,
      "optimizationCOP": number,
      "notes": string
    }
  ],
  "materials": [
    {
      "item": string,
      "qty": number,
      "monthsUse": number,
      "monthlyCOP": number,
      "purchaseType": "mensual" | "unica",
      "totalCOP": number,
      "notes": string
    }
  ],
  "summary": {
    "professionalsTotalCOP": number,
    "materialsTotalCOP": number,
    "optimizationTotalCOP": number,
    "imprevistosCOP": number,
    "productionCostCOP": number,
    "offerValueCOP": number,
    "utilidadPct": number
  }
}

NO incluyas texto por fuera del JSON.
`;

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.15,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices?.[0]?.message?.content || "{}";

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      const cleaned = firstBrace >= 0 && lastBrace >= 0 ? text.slice(firstBrace, lastBrace + 1) : "{}";
      data = JSON.parse(cleaned);
    }

    // seguridad mínima de tipos
    data.assumptions = Array.isArray(data.assumptions) ? data.assumptions : [];
    data.professionals = Array.isArray(data.professionals) ? data.professionals : [];
    data.materials = Array.isArray(data.materials) ? data.materials : [];
    data.summary = typeof data.summary === "object" && data.summary ? data.summary : {};

    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Error ejecutando IA para costeo.",
      details: String(err?.message || err),
    });
  }
});

/**
 * ============================
 *  Guardar / Editar costeo (MVP en memoria)
 * ============================
 */

// Guardar nuevo
app.post("/costings/save", (req, res) => {
  const payload = req.body || {};
  const id = uid();
  const now = new Date().toISOString();

  const record = {
    id,
    objectoContrato: String(payload.objectoContrato || payload.objecto || ""),
    createdAt: now,
    updatedAt: now,
    payload,
  };

  COSTINGS_DB.unshift(record);

  res.json({ ok: true, id, record });
});

// Listar
app.get("/costings/list", (req, res) => {
  const top = Math.min(Number(req.query.top || 50) || 50, 200);
  const list = COSTINGS_DB.slice(0, top).map((r) => ({
    id: r.id,
    objectoContrato: r.objectoContrato,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  res.json({ ok: true, list });
});

// Obtener uno
app.get("/costings/:id", (req, res) => {
  const id = String(req.params.id || "");
  const found = COSTINGS_DB.find((x) => x.id === id);
  if (!found) return res.status(404).json({ ok: false, error: "No existe ese costeo." });
  res.json({ ok: true, record: found });
});

// Actualizar
app.put("/costings/:id", (req, res) => {
  const id = String(req.params.id || "");
  const idx = COSTINGS_DB.findIndex((x) => x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "No existe ese costeo." });

  const now = new Date().toISOString();
  const current = COSTINGS_DB[idx];

  COSTINGS_DB[idx] = {
    ...current,
    objectoContrato: String(req.body?.objectoContrato || current.objectoContrato || ""),
    updatedAt: now,
    payload: req.body || current.payload,
  };

  res.json({ ok: true, record: COSTINGS_DB[idx] });
});

// Eliminar
app.delete("/costings/:id", (req, res) => {
  const id = String(req.params.id || "");
  const before = COSTINGS_DB.length;
  COSTINGS_DB = COSTINGS_DB.filter((x) => x.id !== id);
  const after = COSTINGS_DB.length;

  res.json({ ok: true, deleted: before - after });
});

/**
 * ============================
 *  Arranque del servidor
 *  Render expone el puerto en process.env.PORT
 * ============================
 */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto: ${PORT}`);
  console.log(`OpenAI configurado: ${Boolean(client)}`);
});
