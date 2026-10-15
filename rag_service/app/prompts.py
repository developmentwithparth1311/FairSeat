import json
from typing import Any

from .loaders import Candidate


SYSTEM_RULES = """You are the SAE Candidate Assistant for the PM Internship Scheme allocation tool.
You help ONE candidate understand their allocation result and improve their skills.

Rules:
1. Use ONLY the CANDIDATE FACTS and KNOWLEDGE blocks below. If the answer is not
   there, say you don't know and suggest where to look (e.g. the official scheme website).
2. Never invent numbers, scores, seat counts, deadlines, stipend amounts, or eligibility rules.
3. Quote numbers exactly as given in CANDIDATE FACTS. Do not recalculate them.
4. You cannot change the allocation, scores, or seats. If asked to, explain that you cannot,
   and explain what the candidate can do (improve skills, update their profile through official channels).
5. Be encouraging and practical. Suggest at most 3 concrete next steps, ordered by impact.
6. Use plain, simple language. Keep answers short unless asked for detail.
7. Cite knowledge you used with its label, e.g. [KB-2]. Do not cite facts that came from CANDIDATE FACTS.
8. Reply in the same language as the candidate's question.
9. Never reveal information about any other candidate."""


def build_prompt(candidate: Candidate, analyzer: Any, question: str,
                 retrieved: list[Any], history: list[dict] | None = None,
                 max_history_turns: int = 6, sector: str | None = None) -> tuple[str, list[dict], dict]:
    facts = {
        "candidate": {
            "id": candidate.id,
            "name": candidate.name,
            "skills": candidate.skills,
            "cgpa": candidate.cgpa,
            "sector": candidate.sector,
            "location": candidate.location,
            "allocation": candidate.allocation.model_dump(),
            "top_choices": [choice.model_dump() for choice in candidate.top_choices],
        },
        "skill_gap": analyzer.skill_gap(candidate.id, sector=sector),
        "outcome": analyzer.explain_outcome(candidate.id),
    }
    payload = ["CANDIDATE FACTS", json.dumps(facts, ensure_ascii=False, separators=(",", ":")), "", "KNOWLEDGE"]
    if retrieved:
        for item in retrieved:
            chunk = item.chunk
            payload.append(f"[{item.label}: kb/{chunk.source_path}] {chunk.title} — {chunk.section}\n{chunk.text}")
    else:
        payload.append("No relevant knowledge was found in the knowledge base.")
    recent = (history or [])[-(max_history_turns * 2):] if max_history_turns > 0 else []
    payload.extend(["", "CHAT HISTORY"])
    for message in recent:
        if message.get("role") in {"user", "assistant"}:
            role = "Candidate" if message["role"] == "user" else "Assistant"
            payload.append(f"{role}: {message.get('content', '')}")
    payload.extend(["", "NEW QUESTION", question])
    messages = [{"role": "user", "content": "\n\n".join(payload)}]
    return SYSTEM_RULES, messages, facts
