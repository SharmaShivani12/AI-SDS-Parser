import os
import uuid
import logging
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import (
    FastAPI, UploadFile, File, Depends,
    HTTPException, BackgroundTasks, Request
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from sqlalchemy.orm import Session

from .database import Base, engine, SessionLocal
from . import models, schemas
from .extraction import extract_text_from_pdf, extract_sds_data, extract_sds_llama

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("sds_agent")

# ---------------------------------------------------------------------------
# Config (from environment — never hardcoded)
# ---------------------------------------------------------------------------
API_KEY        = os.getenv("SDS_API_KEY", "")          # empty = auth disabled (dev only)
UPLOAD_DIR     = os.getenv("UPLOAD_DIR", "./uploaded_sds")
MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(20 * 1024 * 1024)))  # 20 MB
ALLOWED_MIME   = {"application/pdf"}

os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# In-memory job store (swap for Redis / DB in production)
# ---------------------------------------------------------------------------
job_store: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Creating database tables if not present …")
    Base.metadata.create_all(bind=engine)
    yield
    logger.info("Shutdown complete.")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="AI SDS Parser", version="1.1.0", lifespan=lifespan)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Optional API-key auth
# ---------------------------------------------------------------------------
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(key: Optional[str] = Depends(api_key_header)):
    """
    If SDS_API_KEY env var is set, every request must supply it in the
    X-API-Key header.  If the env var is empty, auth is skipped (dev mode).
    """
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key")

# ---------------------------------------------------------------------------
# DB dependency
# ---------------------------------------------------------------------------
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
async def _read_and_validate(file: UploadFile) -> bytes:
    """Read file bytes and enforce type + size limits."""
    if file.content_type not in ALLOWED_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file.content_type}'. Only PDF is accepted.",
        )
    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum allowed size is {MAX_FILE_BYTES // (1024*1024)} MB.",
        )
    return contents


def _save_to_disk(original_filename: str, contents: bytes) -> str:
    """Write bytes to UPLOAD_DIR with a UUID prefix to avoid collisions."""
    safe_name = f"{uuid.uuid4()}_{original_filename}"
    file_path = os.path.join(UPLOAD_DIR, safe_name)
    with open(file_path, "wb") as fh:
        fh.write(contents)
    logger.info("Saved upload: %s", file_path)
    return file_path


def _persist_doc(
    db: Session,
    original_filename: str,
    file_path: str,
    extracted,
    text: str,
) -> models.SDSDocument:
    """Insert an SDSDocument row and return the refreshed instance."""
    doc = models.SDSDocument(
        filename=original_filename,
        file_path=file_path,          # store actual path so delete can clean up
        supplier=extracted.supplier,
        raw_text=text,
        extracted=extracted.dict(),
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    logger.info("Persisted SDSDocument id=%s filename=%s", doc.id, doc.filename)
    return doc


# ---------------------------------------------------------------------------
# Background task — AI extraction
# ---------------------------------------------------------------------------
def _run_ai_extraction(job_id: str, file_path: str, filename: str, db: Session):
    """
    Runs in the background after /extract-ai returns immediately.
    Updates job_store so the client can poll /jobs/{job_id}.
    """
    job_store[job_id] = {"status": "processing", "id": None, "error": None}
    try:
        text      = extract_text_from_pdf(file_path)
        extracted = extract_sds_llama(text)
        doc       = _persist_doc(db, filename, file_path, extracted, text)
        job_store[job_id] = {"status": "complete", "id": doc.id, "error": None}
        logger.info("AI extraction complete job_id=%s doc_id=%s", job_id, doc.id)
    except Exception as exc:
        logger.error("AI extraction failed job_id=%s error=%s", job_id, exc)
        job_store[job_id] = {"status": "failed", "id": None, "error": str(exc)}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Routes — standard upload
# ---------------------------------------------------------------------------
@app.post(
    "/upload",
    response_model=schemas.SDSBase,
    dependencies=[Depends(verify_api_key)],
    summary="Upload and parse an SDS PDF (rule-based extraction)",
)
async def upload_sds(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    contents  = await _read_and_validate(file)
    file_path = _save_to_disk(file.filename, contents)

    try:
        text      = extract_text_from_pdf(file_path)
        extracted = extract_sds_data(text)
    except Exception as exc:
        logger.error("Extraction error for %s: %s", file.filename, exc)
        raise HTTPException(status_code=500, detail=f"Extraction failed: {exc}")

    doc = _persist_doc(db, file.filename, file_path, extracted, text)

    return schemas.SDSBase(
        id=doc.id,
        filename=doc.filename,
        created_at=doc.created_at,
        supplier=doc.supplier,
        extracted=extracted,
    )


# ---------------------------------------------------------------------------
# Routes — AI extraction (async, non-blocking)
# ---------------------------------------------------------------------------
@app.post(
    "/extract-ai",
    dependencies=[Depends(verify_api_key)],
    summary="Upload an SDS PDF and extract data with LLaMA (returns job ID immediately)",
)
async def extract_ai(
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: Session = Depends(get_db),
):
    contents  = await _read_and_validate(file)
    file_path = _save_to_disk(file.filename, contents)

    job_id = str(uuid.uuid4())
    job_store[job_id] = {"status": "queued", "id": None, "error": None}

    # Return immediately — extraction happens in the background
    background_tasks.add_task(
        _run_ai_extraction, job_id, file_path, file.filename, SessionLocal()
    )
    logger.info("Queued AI extraction job_id=%s filename=%s", job_id, file.filename)

    return {"job_id": job_id, "status": "queued"}


@app.get(
    "/jobs/{job_id}",
    dependencies=[Depends(verify_api_key)],
    summary="Poll status of an AI extraction job",
)
def get_job(job_id: str):
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# ---------------------------------------------------------------------------
# Routes — list / get / delete
# ---------------------------------------------------------------------------
@app.get(
    "/sds",
    response_model=List[schemas.SDSListItem],
    dependencies=[Depends(verify_api_key)],
    summary="List all SDS documents (paginated)",
)
def list_sds(
    skip: int = 0,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    return (
        db.query(models.SDSDocument)
        .order_by(models.SDSDocument.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@app.get(
    "/sds/{sds_id}",
    response_model=schemas.SDSDetail,
    dependencies=[Depends(verify_api_key)],
    summary="Get full detail for one SDS document",
)
def get_sds(sds_id: int, db: Session = Depends(get_db)):
    doc = db.query(models.SDSDocument).filter(models.SDSDocument.id == sds_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="SDS document not found")

    return schemas.SDSDetail(
        id=doc.id,
        filename=doc.filename,
        created_at=doc.created_at,
        supplier=doc.supplier,
        raw_text=doc.raw_text,
        extracted=schemas.SDSExtracted(**doc.extracted),
    )


@app.delete(
    "/sds/{sds_id}",
    status_code=204,
    dependencies=[Depends(verify_api_key)],
    summary="Delete an SDS document and its uploaded file",
)
def delete_sds(sds_id: int, db: Session = Depends(get_db)):
    doc = db.query(models.SDSDocument).filter(models.SDSDocument.id == sds_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="SDS document not found")

    # Remove file from disk
    file_path = getattr(doc, "file_path", None) or os.path.join(UPLOAD_DIR, doc.filename)
    if file_path and os.path.exists(file_path):
        os.remove(file_path)
        logger.info("Deleted file: %s", file_path)

    db.delete(doc)
    db.commit()
    logger.info("Deleted SDSDocument id=%s", sds_id)
    # 204 — no body returned


# ---------------------------------------------------------------------------
# Health check (no auth — for load balancer / uptime monitors)
# ---------------------------------------------------------------------------
@app.get("/health", include_in_schema=False)
def health():
    return {"status": "ok"}
