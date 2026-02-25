import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== JSON Schema estricto para salida (nada de texto) ======
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
            cargo: { type: "string" },
            perfil: { type: "string" },
            cantidad: { type: "number" },
            meses: { type: "number" },
            dedicacionPct: { type: "number" },
            valorMensual: { type: "number" },
            fuente: { type: "string" },
            confianza: { type: "number" }
          },
          required: ["cargo","perfil","cantidad","meses","dedicacionPct","valorMensual","fuente","confianza"]
        }
      },
      materials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            descripcion: { type: "string" },
            tipo: { type: "string" },
            cantidad: { type: "number" },
            meses: { type: "number" },
            unitPrice: { type: "number" },
            unit: { type: "string" },
            fuentePrecio: { type: "string" },
            confianza: { type: "number" }
          },
          required: ["descripcion","tipo","cantidad","meses","unitPrice","unit","fuentePrecio","confianza"]
        }
      }
    },
    required: ["assumptions","professionals","materials"]
  }
};

// ===== Health check =====
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== IA: genera plan =====
app.post("/ai", async (req, res) => {
  try {
    const {
      methodologyText = "",
      tdrText = "",
      projectData = {},
      salaryTable = []
    } = req.body || {};

    const developer = `
Eres un analista de costos de producción para licitaciones.

REGLAS DURAS:
1) Salarios: SOLO puedes asignar valorMensual si lo puedes justificar con salaryTable. Si no, usa 0 y agrega el supuesto en assumptions.
2) Materiales: NO inventes precios. Si no hay fuente explícita, unitPrice=0, unit="unidad" y fuentePrecio="PENDIENTE COTIZACIÓN".
3) Devuelve SOLO JSON válido según el esquema. Nada de texto adicional.
4) Equipo realista (sin sobrecargar).
5) DedicacionPct entre 10 y 100.
6) Meses coherente con projectData.plazoMeses si existe.
`;

    const input = {
      methodologyText,
      tdrText,
      projectData,
      salaryTable
    };

    const resp = await client.responses.create({
      model: "gpt-5",
      input: [
        { role: "developer", content: developer },
        { role: "user", content: JSON.stringify(input) }
      ],
      response_format: { type: "json_schema", json_schema: COST_SCHEMA }
    });

    const text = resp.output_text;
    const data = JSON.parse(text);
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "Error en /ai" });
  }
});

// ===== Precios unitarios (modo conservador) =====
app.post("/price", async (req, res) => {
  try {
    const { query = "", unitHint = "unidad" } = req.body || {};
    const q = String(query).trim();
    if (!q) {
      return res.json({ ok: true, data: { unitPrice: 0, currency: "COP", unit: unitHint, source: "PENDIENTE", confidence: 0 } });
    }

    // MODO CONSERVADOR (no inventa):
    // Cuando decidas proveedor (MercadoLibre/Homecenter/etc.), aquí se integra real.
    return res.json({
      ok: true,
      data: {
        unitPrice: 0,
        currency: "COP",
        unit: unitHint,
        source: "PENDIENTE COTIZACIÓN (integrar proveedor)",
        confidence: 0
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "Error en /price" });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Server listo en puerto ${port}`));
