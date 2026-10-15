from dataclasses import asdict, dataclass
import hashlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class Chunk:
    text: str
    source_path: str
    title: str
    section: str
    type: str
    chunk_id: str


class SentenceTransformerEmbedder:
    def __init__(self, model_name: str):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise RuntimeError("sentence-transformers is required to build this knowledge index") from exc
        self.model = SentenceTransformer(model_name)

    def encode(self, texts: list[str]) -> np.ndarray:
        return np.asarray(self.model.encode(texts, normalize_embeddings=True), dtype=np.float32)


def _doc_type(path: str) -> str:
    lowered = path.lower()
    if lowered.startswith("companies/"):
        return "company"
    if "/skills/" in f"/{lowered}" or lowered.startswith("skills/"):
        return "skill"
    if "scheme_faq" in lowered:
        return "faq"
    return "process"


def chunk_markdown(text: str, source_path: str, max_tokens: int = 400,
                   overlap_tokens: int = 50) -> list[Chunk]:
    if max_tokens < 1 or overlap_tokens < 0 or overlap_tokens >= max_tokens:
        raise ValueError("Require max_tokens > overlap_tokens >= 0")
    heading = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
    title = Path(source_path).stem.replace("_", " ").replace("-", " ").title()
    section = title
    sections: list[tuple[str, str]] = []
    lines: list[str] = []
    for line in text.splitlines():
        match = heading.match(line)
        if match:
            body = "\n".join(lines).strip()
            if body:
                sections.append((section, body))
            lines = []
            section = match.group(2).strip()
            if match.group(1) == "#":
                title = section
        else:
            lines.append(line)
    body = "\n".join(lines).strip()
    if body:
        sections.append((section, body))

    chunks: list[Chunk] = []
    step = max_tokens - overlap_tokens
    for section_name, section_text in sections:
        words = section_text.split()
        for start in range(0, len(words), step):
            part = words[start:start + max_tokens]
            if not part:
                continue
            chunks.append(Chunk(
                text=" ".join(part), source_path=source_path, title=title,
                section=section_name, type=_doc_type(source_path),
                chunk_id=f"{source_path}#{len(chunks) + 1}",
            ))
            if start + max_tokens >= len(words):
                break
    return chunks


def company_documents(companies: Any) -> list[tuple[str, str]]:
    documents = []
    values = companies.values() if isinstance(companies, dict) else companies
    for company in values:
        if isinstance(company, dict):
            get = company.get
        else:
            get = lambda key, default=None: getattr(company, key, default)
        skills = ", ".join(get("required_skills")) or "none listed"
        text = (
            f"# {get('name')}\n\nSector: {get('sector')}\nLocation: {get('location')}\n"
            f"Seats: {get('seats')} (filled: {get('seats_filled', 0)})\n"
            f"Required skills: {skills}."
        )
        documents.append((f"companies/{get('id')}.md", text))
    return documents


def read_documents(kb_dir: Path, companies: Any) -> list[tuple[str, str]]:
    docs = []
    if kb_dir.exists():
        for path in sorted(kb_dir.rglob("*.md")):
            docs.append((path.relative_to(kb_dir).as_posix(), path.read_text(encoding="utf-8")))
    docs.extend(company_documents(companies))
    return docs


def content_hash(documents: list[tuple[str, str]]) -> str:
    digest = hashlib.sha256()
    for path, text in sorted(documents):
        digest.update(path.encode())
        digest.update(b"\0")
        digest.update(text.encode())
        digest.update(b"\0")
    return digest.hexdigest()


class KBIndex:
    def __init__(self, chunks: list[Chunk], vectors: np.ndarray, embedder: Any,
                 faiss_index: Any = None):
        self.chunks = chunks
        self.vectors = np.asarray(vectors, dtype=np.float32)
        self.embedder = embedder
        self.faiss_index = faiss_index

    @classmethod
    def build_or_load(cls, kb_dir: Path, companies: Any, index_dir: Path,
                      embedder: Any = None,
                      model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        documents = read_documents(kb_dir, companies)
        digest = content_hash(documents)
        index_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = index_dir / "metadata.json"
        chunks_path = index_dir / "chunks.json"
        vectors_path = index_dir / "vectors.npy"
        index_path = index_dir / "index.faiss"
        active_embedder = embedder or SentenceTransformerEmbedder(model_name)

        if metadata_path.exists() and chunks_path.exists() and vectors_path.exists():
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("content_hash") == digest and metadata.get("model_name") == model_name:
                chunks = [Chunk(**item) for item in json.loads(chunks_path.read_text(encoding="utf-8"))]
                vectors = np.load(vectors_path)
                faiss_index = cls._load_faiss(index_path) if index_path.exists() else None
                return cls(chunks, vectors, active_embedder, faiss_index)

        chunks = [chunk for path, text in documents for chunk in chunk_markdown(text, path)]
        vectors = active_embedder.encode([chunk.text for chunk in chunks]) if chunks else np.empty((0, 0), dtype=np.float32)
        vectors = cls._normalize(vectors)
        np.save(vectors_path, vectors)
        chunks_path.write_text(json.dumps([asdict(chunk) for chunk in chunks], ensure_ascii=False), encoding="utf-8")
        metadata_path.write_text(json.dumps({"content_hash": digest, "model_name": model_name}), encoding="utf-8")
        faiss_index = cls._make_faiss(vectors)
        if faiss_index is not None:
            cls._save_faiss(faiss_index, index_path)
        elif index_path.exists():
            index_path.unlink()
        return cls(chunks, vectors, active_embedder, faiss_index)

    @staticmethod
    def _normalize(vectors: np.ndarray) -> np.ndarray:
        vectors = np.asarray(vectors, dtype=np.float32)
        if vectors.ndim == 1:
            vectors = vectors.reshape(1, -1)
        if vectors.size == 0:
            return vectors
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        return vectors / np.maximum(norms, 1e-12)

    @staticmethod
    def _make_faiss(vectors: np.ndarray):
        if vectors.size == 0:
            return None
        try:
            import faiss
        except ImportError:
            return None
        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(vectors)
        return index

    @staticmethod
    def _save_faiss(index: Any, path: Path) -> None:
        import faiss
        faiss.write_index(index, str(path))

    @staticmethod
    def _load_faiss(path: Path):
        try:
            import faiss
        except ImportError:
            return None
        return faiss.read_index(str(path))

    def search(self, query: str, k: int = 4) -> list[tuple[Chunk, float]]:
        if not self.chunks or k <= 0:
            return []
        query_vector = self._normalize(self.embedder.encode([query]))
        if self.faiss_index is not None:
            scores, indices = self.faiss_index.search(query_vector, min(k, len(self.chunks)))
            return [(self.chunks[int(i)], float(score)) for i, score in zip(indices[0], scores[0]) if i >= 0]
        scores = self.vectors @ query_vector[0]
        indices = np.argsort(scores)[::-1][:k]
        return [(self.chunks[int(i)], float(scores[i])) for i in indices]
