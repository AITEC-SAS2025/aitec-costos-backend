import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 10000;

// --- OpenAI (opcional si hay API Key) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// --- “Base de datos” en memoria (MVP) ---
let professionalsDB = [];   // [{ id, title, monthlyValue, tags: [] }]
let costingsDB = [];        // [{ id, name, object, professionals: [], materials: [], totals, createdAt }]

// --- Utilidades ---
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// --- Rutas básicas ---
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
      openaiConfigured: !!client
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "aitec-costos-backend" });
});

// --- IA: generar sugerencia de profesionales y materiales ---
app.post("/ai/costeo", async (req, res) => {
  try {
    if (!client) {
      return res.status(400).json({ error: "OPENAI_API_KEY no configurada en Render" });
    }

    const { metodologia = "", tdr = "", notas = "" } = req.body;

    const prompt = `
Eres un asistente técnico para costeo de proyectos.
Con base en la metodología, TDR y notas, devuelve un JSON estricto con:
- assumptions: string[]
- professionals: [{ role, quantity, months, dedicationPct, monthlyValue }]
- materials: [{ name, quantity, months, monthlyValue }]
No incluyas texto fuera del JSON.

Metodología:
${metodologia}

TDR:
${tdr}

Notas:
${notas}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Devuelve SOLO JSON válido." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });

    const text = completion.choices[0].message.content.trim();
    const json = JSON.parse(text);
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en IA", detail: err.message });
  }
});

// --- Materiales (búsqueda simple mock; luego puedes conectar API real) ---
app.get("/materials/search", async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const top = parseInt(req.query.top || "8", 10);

  // Mock simple (puedes reemplazar por scraping/API real)
  const catalog = [
    { name: "Licencia ArcGIS", monthlyValue: 450000 },
    { name: "Licencia QGIS (soporte)", monthlyValue: 120000 },
    { name: "Servidor VPS", monthlyValue: 180000 },
    { name: "Laptop profesional", monthlyValue: 350000 },
    { name: "Viáticos campo", monthlyValue: 300000 },
    { name: "Transporte terrestre", monthlyValue: 220000 },
    { name: "Papelería", monthlyValue: 50000 },
    { name: "Disco duro externo", monthlyValue: 90000 }
  ];

  const results = catalog
    .filter(i => i.name.toLowerCase().includes(q))
    .slice(0, top);

  res.json({ query: q, results });
});

// --- Profesionales: cargar base (desde Excel transformado a JSON en frontend) ---
app.post("/professionals/load", (req, res) => {
  const { professionals = [] } = req.body; // [{ title, monthlyValue, tags }]
  professionalsDB = professionals.map(p => ({ id: uid(), ...p }));
  res.json({ ok: true, count: professionalsDB.length });
});

// --- Profesionales: buscar ---
app.get("/professionals/search", (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const results = professionalsDB.filter(p =>
    p.title.toLowerCase().includes(q) ||
    (p.tags || []).some(t => t.toLowerCase().includes(q))
  );
  res.json({ query: q, results });
});

// --- Costings: guardar ---
app.post("/costings/save", (req, res) => {
  const { name, object, professionals = [], materials = [], totals = {} } = req.body;
  const record = {
    id: uid(),
    name,
    object,
    professionals,
    materials,
    totals,
    createdAt: new Date().toISOString()
  };
  costingsDB.push(record);
  res.json({ ok: true, id: record.id });
});

// --- Costings: listar ---
app.get("/costings/list", (req, res) => {
  res.json(costingsDB);
});

// --- Costings: obtener ---
app.get("/costings/:id", (req, res) => {
  const item = costingsDB.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: "No encontrado" });
  res.json(item);
});

// --- Costings: actualizar ---
app.put("/costings/:id", (req, res) => {
  const idx = costingsDB.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "No encontrado" });
  costingsDB[idx] = { ...costingsDB[idx], ...req.body };
  res.json({ ok: true });
});

// --- Costings: eliminar ---
app.delete("/costings/:id", (req, res) => {
  costingsDB = costingsDB.filter(c => c.id !== req.params.id);
  res.json({ ok: true });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto: ${PORT}`);
});
