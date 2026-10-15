import hashlib
from pathlib import Path

import numpy as np

from app.kb_index import KBIndex, chunk_markdown
from app.retriever import Retriever


class LocalWordEmbedder:
    """Small deterministic lexical embedder for offline retrieval tests."""

    def encode(self, texts):
        vectors = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in text.lower().split():
                column = int.from_bytes(hashlib.sha256(token.strip(".,!?;:#()[]").encode()).digest()[:2], "little") % 256
                vectors[row, column] += 1.0
        return vectors


def test_chunker_keeps_heading_metadata_and_respects_size():
    text = "# Docker\n\n## What it is\n" + "container runtime basics " * 25
    chunks = chunk_markdown(text, "skills/docker.md", max_tokens=12, overlap_tokens=3)
    assert chunks
    assert all(chunk.title == "Docker" for chunk in chunks)
    assert all(chunk.section == "What it is" for chunk in chunks)
    assert all(len(chunk.text.split()) <= 12 for chunk in chunks)
    assert all(chunk.type == "skill" for chunk in chunks)


def test_retriever_finds_skill_document_and_persists_cache(tmp_path: Path):
    kb = tmp_path / "kb"
    (kb / "skills").mkdir(parents=True)
    (kb / "skills" / "docker.md").write_text(
        "# Docker\n\n## What it is\nDocker packages an app into containers.\n\n"
        "## How to get started\nLearn images and containers with a small local app.\n"
    )
    (kb / "how_allocation_works.md").write_text(
        "# Allocation\n\n## Seats\nCompanies have fixed seats and candidates rank choices.\n"
    )
    embedder = LocalWordEmbedder()
    index_dir = tmp_path / "index"
    index = KBIndex.build_or_load(kb, [], index_dir, embedder=embedder, model_name="offline-test")
    retrieved = Retriever(index, minimum_similarity=0.1).retrieve("how do I learn docker")
    assert retrieved
    assert retrieved[0].chunk.source_path == "skills/docker.md"
    assert retrieved[0].chunk.type == "skill"
    reloaded = KBIndex.build_or_load(kb, [], index_dir, embedder=embedder, model_name="offline-test")
    assert reloaded.chunks[0].chunk_id == index.chunks[0].chunk_id


def test_company_documents_have_company_metadata():
    from app.kb_index import company_documents

    docs = company_documents([{
        "id": "X1", "name": "Example", "required_skills": ["SQL"],
        "seats": 2, "seats_filled": 1, "sector": "IT", "location": "Pune",
    }])
    chunk = chunk_markdown(docs[0][1], docs[0][0])[0]
    assert chunk.type == "company"
    assert "SQL" in chunk.text
