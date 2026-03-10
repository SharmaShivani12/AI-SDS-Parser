import { useState } from "react";

const stages = [
  {
    id: 1,
    icon: "📄",
    title: "PDF Input",
    subtitle: "Raw Documents",
    color: "#6366f1",
    libraries: ["PyMuPDF (fitz)", "os", "pathlib"],
    description: "Thousands of SDS PDFs from different manufacturers are ingested. Each PDF is opened and processed page by page.",
    code: `import fitz  # PyMuPDF
import os

def load_pdf(pdf_path: str):
    doc = fitz.open(pdf_path)
    print(f"Loaded: {pdf_path}")
    print(f"Pages: {doc.page_count}")
    return doc`,
  },
  {
    id: 2,
    icon: "🔍",
    title: "Text Extraction",
    subtitle: "PyMuPDF + OCR Fallback",
    color: "#8b5cf6",
    libraries: ["PyMuPDF (fitz)", "pytesseract", "Pillow (PIL)"],
    description: "PyMuPDF extracts raw text from digital PDFs. If text is too short (scanned PDF), Tesseract OCR reads the page as an image — fallback for scanned documents.",
    code: `import fitz
import pytesseract
from PIL import Image

def extract_text(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    full_text = ""

    for page in doc:
        text = page.get_text()

        # Fallback: scanned PDF → use OCR
        if len(text.strip()) < 50:
            pix = page.get_pixmap()
            img = Image.frombytes(
                "RGB", [pix.width, pix.height], pix.samples
            )
            text = pytesseract.image_to_string(img)

        full_text += text

    return full_text`,
  },
  {
    id: 3,
    icon: "🧠",
    title: "LLM Extraction",
    subtitle: "Local LLM via Ollama",
    color: "#a855f7",
    libraries: ["Ollama", "Phi / Llama (local model)", "LangChain (optional)"],
    description: "Raw text is passed into a local LLM (Phi/Llama via Ollama) with a structured prompt. The LLM reads and extracts specific fields as JSON. No data leaves your network.",
    code: `import ollama

def extract_fields_with_llm(raw_text: str) -> dict:
    prompt = f"""
    Read this SDS document and extract fields as JSON only:
    - chemical_name
    - cas_number
    - flash_point
    - hazard_level
    - manufacturer

    Document:
    {raw_text[:3000]}

    Return ONLY valid JSON, no explanation.
    """

    response = ollama.chat(
        model="phi",
        messages=[{"role": "user", "content": prompt}]
    )

    return response['message']['content']`,
  },
  {
    id: 4,
    icon: "✅",
    title: "Pydantic Validation",
    subtitle: "Schema Enforcement",
    color: "#ec4899",
    libraries: ["Pydantic", "Pydantic AI", "re (regex)"],
    description: "LLM output is validated against a strict Pydantic schema. Wrong types, missing fields, or invalid formats (like bad CAS numbers) are caught here — before touching the DB.",
    code: `from pydantic import BaseModel, validator
import re

class SDSExtraction(BaseModel):
    chemical_name: str
    cas_number: str
    flash_point: float
    hazard_level: str
    manufacturer: str
    confidence_score: float = 0.0

    @validator('cas_number')
    def validate_cas(cls, v):
        if not re.match(r'\\d{2,7}-\\d{2}-\\d', v):
            raise ValueError('Invalid CAS number format')
        return v

    @validator('flash_point')
    def validate_flash(cls, v):
        if v < -100 or v > 1000:
            raise ValueError('Flash point out of range')
        return v`,
  },
  {
    id: 5,
    icon: "👁️",
    title: "Human-in-the-Loop",
    subtitle: "Review & Validation",
    color: "#f59e0b",
    libraries: ["FastAPI", "PostgreSQL", "SQLAlchemy"],
    description: "Low confidence extractions (score < 0.85) go to a 'pending' table. A human reviewer sees the extracted fields side-by-side with the PDF and can approve, edit, or reject.",
    code: `from sqlalchemy import Column, String, Float, Enum
from database import Base

class ExtractionRecord(Base):
    __tablename__ = "extractions"

    id = Column(String, primary_key=True)
    chemical_name = Column(String)
    cas_number = Column(String)
    flash_point = Column(Float)
    confidence_score = Column(Float)
    status = Column(
        Enum("pending", "approved", "rejected"),
        default="pending"
    )
    source_pdf = Column(String)

# Routing logic
def route_extraction(data: SDSExtraction):
    if data.confidence_score < 0.85:
        data.status = "pending"   # → human review
    else:
        data.status = "approved"  # → auto commit
    return data`,
  },
  {
    id: 6,
    icon: "🚀",
    title: "FastAPI Layer",
    subtitle: "REST API + Orchestration",
    color: "#10b981",
    libraries: ["FastAPI", "Uvicorn", "Pydantic", "Python-multipart"],
    description: "FastAPI wraps the entire pipeline as REST endpoints. Upload a PDF, trigger extraction, review pending items, approve/reject — all via HTTP. This makes it usable by any frontend or service.",
    code: `from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse

app = FastAPI(title="SDS Parser API")

@app.post("/extract")
async def extract_sds(file: UploadFile = File(...)):
    # 1. Save uploaded PDF
    pdf_bytes = await file.read()

    # 2. Extract text (PyMuPDF + OCR fallback)
    raw_text = extract_text_from_bytes(pdf_bytes)

    # 3. LLM extraction
    llm_output = extract_fields_with_llm(raw_text)

    # 4. Pydantic validation
    validated = SDSExtraction.parse_raw(llm_output)

    # 5. Route to DB
    record = route_extraction(validated)
    save_to_db(record)

    return JSONResponse({"status": record.status, "id": record.id})

@app.get("/pending")
async def get_pending():
    return get_all_pending_records()

@app.patch("/approve/{record_id}")
async def approve(record_id: str):
    return update_status(record_id, "approved")`,
  },
  {
    id: 7,
    icon: "🐳",
    title: "Docker + PostgreSQL",
    subtitle: "Production Deployment",
    color: "#0ea5e9",
    libraries: ["Docker", "Docker Compose", "PostgreSQL", "SQLAlchemy", "Alembic"],
    description: "Everything is containerized. FastAPI app, PostgreSQL DB, and Ollama LLM each run in separate containers. Docker Compose orchestrates them together in production.",
    code: `# docker-compose.yml
version: "3.8"
services:

  api:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db/sds
      - OLLAMA_URL=http://ollama:11434
    depends_on:
      - db
      - ollama

  db:
    image: postgres:15
    environment:
      POSTGRES_DB: sds
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
    volumes:
      - pgdata:/var/lib/postgresql/data

  ollama:
    image: ollama/ollama
    volumes:
      - ollama_data:/root/.ollama

volumes:
  pgdata:
  ollama_data:`,
  },
];

const Arrow = () => (
  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", margin: "4px 0" }}>
    <div style={{ width: 2, height: 24, background: "linear-gradient(to bottom, #6366f1, #0ea5e9)", borderRadius: 2 }} />
    <div style={{ position: "absolute", marginTop: 20, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "8px solid #0ea5e9" }} />
  </div>
);

export default function SDSPipeline() {
  const [selected, setSelected] = useState(null);

  const stage = stages.find((s) => s.id === selected);

  return (
    <div style={{ fontFamily: "'Courier New', monospace", background: "#0f0f1a", minHeight: "100vh", padding: "24px 16px", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#a78bfa", letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>
            SDS Parser Agent
          </h1>
          <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
            Click any stage to see libraries & code
          </p>
        </div>

        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          {/* Pipeline Column */}
          <div style={{ flex: "0 0 260px" }}>
            {stages.map((s, i) => (
              <div key={s.id}>
                <div
                  onClick={() => setSelected(selected === s.id ? null : s.id)}
                  style={{
                    background: selected === s.id ? `${s.color}22` : "#1e1e2e",
                    border: `1.5px solid ${selected === s.id ? s.color : "#2d2d44"}`,
                    borderRadius: 12,
                    padding: "12px 16px",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 10,
                    background: `${s.color}33`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 18, flexShrink: 0,
                    border: `1px solid ${s.color}55`
                  }}>
                    {s.icon}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: selected === s.id ? s.color : "#e2e8f0" }}>
                      {s.title}
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                      {s.subtitle}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {selected === s.id ? "▲" : "▼"}
                  </div>
                </div>
                {i < stages.length - 1 && <Arrow />}
              </div>
            ))}
          </div>

          {/* Detail Panel */}
          <div style={{ flex: 1, position: "sticky", top: 24 }}>
            {!stage ? (
              <div style={{
                background: "#1e1e2e", border: "1.5px dashed #2d2d44",
                borderRadius: 16, padding: 40, textAlign: "center", color: "#475569"
              }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>👈</div>
                <div style={{ fontSize: 14 }}>Select a pipeline stage to see<br />libraries and code snippet</div>
              </div>
            ) : (
              <div style={{
                background: "#1e1e2e", border: `1.5px solid ${stage.color}`,
                borderRadius: 16, overflow: "hidden",
                boxShadow: `0 0 30px ${stage.color}22`
              }}>
                {/* Panel Header */}
                <div style={{ background: `${stage.color}22`, padding: "16px 20px", borderBottom: `1px solid ${stage.color}44` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 24 }}>{stage.icon}</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: stage.color }}>{stage.title}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{stage.subtitle}</div>
                    </div>
                  </div>
                  <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
                    {stage.description}
                  </p>
                </div>

                {/* Libraries */}
                <div style={{ padding: "14px 20px", borderBottom: `1px solid #2d2d44` }}>
                  <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                    Libraries Used
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {stage.libraries.map((lib) => (
                      <span key={lib} style={{
                        background: `${stage.color}22`, border: `1px solid ${stage.color}55`,
                        color: stage.color, borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 600
                      }}>
                        {lib}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Code */}
                <div style={{ padding: "14px 20px" }}>
                  <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
                    Code Snippet
                  </div>
                  <pre style={{
                    background: "#0f0f1a", border: "1px solid #2d2d44",
                    borderRadius: 10, padding: 16, fontSize: 11,
                    color: "#a5f3fc", overflowX: "auto", margin: 0,
                    lineHeight: 1.7, whiteSpace: "pre-wrap"
                  }}>
                    {stage.code}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Legend */}
        <div style={{ marginTop: 32, padding: "16px 20px", background: "#1e1e2e", borderRadius: 12, border: "1px solid #2d2d44" }}>
          <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            Full Pipeline Summary
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "#94a3b8" }}>
            {stages.map((s, i) => (
              <span key={s.id}>
                <span style={{ color: s.color }}>{s.icon} {s.title}</span>
                {i < stages.length - 1 && <span style={{ color: "#334155", margin: "0 6px" }}>→</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
