# 🧪 AI SDS Parser  
A web application that extracts Safety Data Sheet (SDS) information using both **Normal PDF parsing** and **Local AI LLM extraction (Phi-3/LLaMA via Ollama)**.

Upload a PDF → Extract structured SDS fields → Store → View → Manage.

📄 PDF Input→🔍 Text Extraction→🧠 LLM Extraction→✅ Pydantic Validation→👁️ Human-in-the-Loop→🚀 FastAPI Layer→🐳 Docker + PostgreSQL
---

## 🚀 Features

| Feature | Status |
|---|---|
| Upload SDS PDF normally | ✅ |
| Extract SDS using Local AI (Phi-3 / LLaMA) | ✅ |
| Stores extracted data in SQLite DB | ✅ |
| View SDS list & open details | ✅ |
| Delete SDS records | ✅ |
| Frontend built with Vue + Vite | 🔥 |
| Backend built with FastAPI | 🔥 |
| Local model inference using Ollama | 🧠 |

---

## 🏗 Technology Stack

| Layer | Tools Used |
|---|---|
| Backend | FastAPI, SQLAlchemy, Pydantic |
| Frontend | Vue 3 + Vite |
| Database | SQLite (default) |
| Local LLM | Ollama (Phi-3 / LLaMA) |
| Extraction | PyPDF2 + AI JSON prompt |

---
## Demo

https://github.com/user-attachments/assets/0da65b6b-31a0-41ca-91bc-738e113131d3

## 📦 Installation & Setup

### 1️⃣ Clone repository

```bash
git clone <repo-url>
cd AI_SDS_Parserapp
