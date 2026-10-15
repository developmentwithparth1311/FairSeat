from dataclasses import dataclass
import re

from .kb_index import Chunk, KBIndex


@dataclass
class RetrievedChunk:
    chunk: Chunk
    score: float
    label: str


class Retriever:
    def __init__(self, index: KBIndex, company_names: list[str] | None = None,
                 minimum_similarity: float = 0.25):
        self.index = index
        self.company_names = company_names or []
        self.minimum_similarity = minimum_similarity

    def retrieve(self, query: str, k: int = 4, filters: dict | None = None) -> list[RetrievedChunk]:
        intents = self._intent_types(query)
        company_terms = [name.lower() for name in self.company_names if name.lower() in query.lower()]
        ranked = self.index.search(query, max(k * 5, k))
        candidates = []
        for chunk, score in ranked:
            if filters and any(getattr(chunk, key, None) != value for key, value in filters.items()):
                continue
            boosted = score
            if chunk.type in intents:
                boosted += 0.08
            if company_terms and chunk.type == "company" and any(
                term in f"{chunk.title} {chunk.text}".lower() for term in company_terms
            ):
                boosted += 0.15
            if boosted >= self.minimum_similarity:
                candidates.append((chunk, boosted))
        candidates.sort(key=lambda pair: pair[1], reverse=True)
        return [RetrievedChunk(chunk, score, f"KB-{i + 1}")
                for i, (chunk, score) in enumerate(candidates[:k])]

    @staticmethod
    def _intent_types(query: str) -> set[str]:
        lowered = query.lower()
        if re.search(r"skill|learn|improv|roadmap|beginner|practice|docker|python|sql|excel", lowered):
            return {"skill"}
        if re.search(r"allocat|preference|stable|seat|cutoff|match", lowered):
            return {"process", "faq"}
        return set()
