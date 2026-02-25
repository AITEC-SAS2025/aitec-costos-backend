import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";
import XLSX from "xlsx";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" })); // importante: NO aceptar base64 enormes en JSON

// Multer: subidas en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 } // 12MB
});

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

let client = null;
if (OPENAI_API_KEY) client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== Almacenamiento simple en memoria (MVP) ======
// OJO: en Render Free esto se borra si reinicia. Para producción: BD (Postgres, etc.)
const DB = {
  professionals: [], // cargados desde excel
  costings: [] // guardados
};

function nowISO() {
  return new Date().toISOString();
}

function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function chunkText(text, maxChars = 9000) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxChars));
    i += maxChars;
  }
  return chunks;
}

// Si llega texto con data:application/pdf;base64..., lo bloqueamos (esa era la causa del desastre)
function rejectBase64PDF(text) {
  if (!text) return false;
  const t = String(text);
  return t.includes("data:application/pdf;base64");
}

// Root
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "API de Costos AITEC funcionando correctamente 🚀",
    docs: {
      health: "/health",
      aiCosteo: "POST /ai/costeo (multipart: metodologia_pdf, tdr_pdf, + fields)",
      professionalsLoad: "POST /professionals/load (multipart: excel)",
      professionalsSearch: "GET /professionals/search?q=...",
      costingsSave: "POST /costings/save",
      costingsList: "GET /costings/list",
      costingsGet: "GET /costings/:id",
      costingsUpdate: "PUT /costings/:id",
      costingsDelete: "DELETE /costings/:id"
    },
    openaiConfigured: Boolean(OPENAI_API_KEY)
  });
});

app.get("/health", (req, res) => res.json({ ok: true, ts: nowISO() }));

// ====== Profesionales (Excel) ======
app.post("/professionals/load", upload.single("excel"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta archivo excel" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // MVP: intenta mapear columnas comunes (ajusta si tus headers son distintos)
    DB.professionals = rows.map((r, idx) => {
      const perfil = r["Perfil"] || r["perfil"] || r["Cargo"] || r["cargo"] || r["Rol"] || r["rol"] || "";
      const valor = r["Valor mensual"] || r["valor mensual"] || r["Salario"] || r["salario"] || r["Tarifa"] || r["tarifa"] || "";
      const seniority = r["Experiencia"] || r["experiencia"] || r["Años"] || r["años"] || "";

      return {
        id: String(idx + 1),
        perfil: String(perfil).trim(),
        valor_mensual: safeNumber(String(valor).replace(/[^\d.-]/g, ""), 0),
        seniority: String(seniority).trim()
      };
    }).filter(p => p.perfil);

    res.json({ ok: true, loaded: DB.professionals.length });
  } catch (e) {
    res.status(500).json({ error: "No se pudo cargar Excel", detail: String(e) });
  }
});

app.get("/professionals/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  if (!q) return res.json({ items: [] });

  const items = DB.professionals
    .filter(p => (p.perfil || "").toLowerCase().includes(q))
    .slice(0, 20);

  res.json({ items });
});

// ====== Guardar/editar costeo (MVP memoria) ======
app.post("/costings/save", (req, res) => {
  const payload = req.body || {};
  const id = String(Date.now());
  DB.costings.push({ id, createdAt: nowISO(), updatedAt: nowISO(), payload });
  res.json({ ok: true, id });
});

app.get("/costings/list", (req, res) => {
  res.json({
    items: DB.costings.map(c => ({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      objeto: c.payload?.objeto || ""
    })).slice(-50).reverse()
  });
});

app.get("/costings/:id", (req, res) => {
  const c = DB.costings.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "No encontrado" });
  res.json({ ok: true, item: c });
});

app.put("/costings/:id", (req, res) => {
  const c = DB.costings.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "No encontrado" });
  c.payload = req.body || {};
  c.updatedAt = nowISO();
  res.json({ ok: true });
});

app.delete("/costings/:id", (req, res) => {
  const idx = DB.costings.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "No encontrado" });
  DB.costings.splice(idx, 1);
  res.json({ ok: true });
});

// ====== IA Costeo (PDFs + texto) ======
app.post(
  "/ai/costeo",
  upload.fields([
    { name: "metodologia_pdf", maxCount: 1 },
    { name: "tdr_pdf", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!client) return res.status(500).json({ error: "OPENAI_API_KEY no configurada en el servidor" });

      const objeto = String(req.body.objeto || "").trim();
      const notas = String(req.body.notas || "").trim();

      const factorPrestacional = safeNumber(req.body.factorPrestacional, 1.58);
      const imprevistosPct = safeNumber(req.body.imprevistosPct, 5);
      const margenPct = safeNumber(req.body.margenPct, 30);
      const presupuestoFijo = safeNumber(req.body.presupuestoFijo || 0, 0);

      const metodologiaText = String(req.body.metodologiaText || "");
      const tdrText = String(req.body.tdrText || "");

      if (rejectBase64PDF(metodologiaText) || rejectBase64PDF(tdrText)) {
        return res.status(400).json({
          error: "Estás pegando un PDF en base64. NO lo pegues. Súbelo como archivo usando el botón."
        });
      }

      let metaPDFText = "";
      let tdrPDFText = "";

      const metodologiaFile = req.files?.metodologia_pdf?.[0];
      const tdrFile = req.files?.tdr_pdf?.[0];

      if (metodologiaFile) {
        const parsed = await pdfParse(metodologiaFile.buffer);
        metaPDFText = (parsed.text || "").trim();
      }
      if (tdrFile) {
        const parsed = await pdfParse(tdrFile.buffer);
        tdrPDFText = (parsed.text || "").trim();
      }

      // Fuente final para IA: texto pegado + texto extraído del PDF
      const fullTextRaw = [
        "OBJETO:\n" + objeto,
        "NOTAS:\n" + notas,
        "METODOLOGÍA (texto):\n" + metodologiaText,
        "TDR (texto):\n" + tdrText,
        "METODOLOGÍA (PDF extraído):\n" + metaPDFText,
        "TDR (PDF extraído):\n" + tdrPDFText
      ].join("\n\n");

      // Recorte defensivo
      const fullText = fullTextRaw.replace(/\s+/g, " ").trim();

      // Si es gigante, hacemos resumen por chunks para evitar request too large
      const chunks = chunkText(fullText, 9000);
      let condensed = "";

      if (chunks.length > 1) {
        const partials = [];
        for (let i = 0; i < chunks.length; i++) {
          const r = await client.chat.completions.create({
            model: MODEL,
            messages: [
              {
                role: "system",
                content:
                  "Resume en español, en máximo 12 viñetas, solo requisitos operativos: actividades, entregables, perfiles requeridos y materiales/equipos."
              },
              { role: "user", content: chunks[i] }
            ],
            temperature: 0.2
          });
          partials.push(r.choices?.[0]?.message?.content || "");
        }

        const r2 = await client.chat.completions.create({
          model: MODEL,
          messages: [
            {
              role: "system",
              content:
                "Fusiona estos resúmenes en uno solo, sin repetir, manteniendo requisitos y necesidades de personal/materiales."
            },
            { role: "user", content: partials.join("\n\n---\n\n") }
          ],
          temperature: 0.2
        });
        condensed = r2.choices?.[0]?.message?.content || "";
      } else {
        condensed = fullText;
      }

      // Pedimos a IA: profesionales + materiales con costos unitarios estimados y parámetros
      const schema = {
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
                cargo: { type: "string" },
                cantidad: { type: "number" },
                meses: { type: "number" },
                dedicacion: { type: "number" }, // 0..1
                valor_mensual: { type: "number" },
                fuente_valor: { type: "string" }
              },
              required: ["cargo", "cantidad", "meses", "dedicacion", "valor_mensual", "fuente_valor"]
            }
          },
          materials: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                item: { type: "string" },
                cantidad: { type: "number" },
                meses: { type: "number" },
                valor_unitario: { type: "number" },
                tipo: { type: "string" }
              },
              required: ["item", "cantidad", "meses", "valor_unitario", "tipo"]
            }
          }
        },
        required: ["assumptions", "professionals", "materials"]
      };

      // Si tenemos BD de profesionales, le pasamos una muestra para estimar valores
      const samplePros = DB.professionals.slice(0, 50);

      const prompt = `
Necesito que armes un costeo preliminar para una propuesta.
Parámetros financieros:
- factor_prestacional = ${factorPrestacional}
- imprevistos_pct = ${imprevistosPct}
- margen_pct = ${margenPct}
- presupuesto_fijo = ${presupuestoFijo}

Reglas:
1) Profesionales: define cargo, cantidad, meses, dedicación (0 a 1), valor_mensual.
2) Valor mensual: si encuentras match aproximado en la BD (muestra), úsalo. Si no, estima según notas y complejidad y pon fuente_valor="estimado".
3) Materiales: lista items (software/hardware/papelería/desplazamientos/viáticos/etc.) con cantidad, meses, valor_unitario estimado y tipo.
4) Devuelve SOLO JSON válido, sin texto adicional.

Contexto resumido:
${condensed}

Muestra BD de profesionales (para aproximar valores mensuales):
${JSON.stringify(samplePros)}
`.trim();

      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: "Eres un analista de costos. Respondes SOLO JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: "cost_plan", schema } }
      });

      const content = resp.choices?.[0]?.message?.content || "{}";
      const json = JSON.parse(content);

      res.json({
        ok: true,
        input: { objeto, factorPrestacional, imprevistosPct, margenPct, presupuestoFijo },
        plan: json
      });
    } catch (e) {
      const msg = String(e?.message || e);
      // Si OpenAI devuelve error de tamaño/cuota, lo devolvemos con claridad
      if (msg.includes("429") || msg.toLowerCase().includes("rate") || msg.toLowerCase().includes("quota")) {
        return res.status(429).json({
          error: "Límite/cuota o tamaño excedido en OpenAI",
          detail: msg
        });
      }
      res.status(500).json({ error: "Error en IA", detail: msg });
    }
  }
);

app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto:", PORT);
});
