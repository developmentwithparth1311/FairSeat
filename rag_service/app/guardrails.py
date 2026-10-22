import logging
import re
import unicodedata


logger = logging.getLogger(__name__)
DISCLAIMER = "This assistant gives guidance only. Final allocation decisions are made by the official process."


class InputError(ValueError):
    pass


def clean_message(message: str, max_length: int = 1000) -> str:
    cleaned = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in message)
    cleaned = cleaned.strip()
    if not cleaned:
        raise InputError("Message must not be empty.")
    if len(cleaned) > max_length:
        raise InputError(f"Message must be {max_length} characters or fewer.")
    return cleaned


def asks_for_other_candidate(message: str, current_candidate_id: str) -> bool:
    normalized_current = current_candidate_id.upper()
    mentioned = {value.upper() for value in re.findall(r"\bC\d+\b", message, flags=re.I)}
    for match in re.finditer(r"\bcandidate\s+(?:id\s*)?([A-Za-z]*\d+)\b", message, flags=re.I):
        mentioned.add(match.group(1).upper())
    if not mentioned:
        return False
    # The current C-prefixed and raw numeric forms are accepted as the same ID.
    normalized_forms = {normalized_current}
    normalized_forms.add(re.sub(r"^C", "", normalized_current))
    return any(re.sub(r"^C", "", item) not in {re.sub(r"^C", "", x) for x in normalized_forms}
               for item in mentioned)


def is_out_of_scope(message: str, known_skills: set[str] | None = None) -> bool:
    lowered = message.lower()
    coding_request = re.search(r"\b(write|debug|fix|review|generate)\b.{0,30}\b(code|script|function|program|bug)\b", lowered)
    allocation_terms = re.search(
        r"intern(ship)?|allocation|allocat|match|company|seat|score|candidate|scheme|stipend|eligib|deadline|cgpa|sector|location|profile|learn|improv|skill|missing|preference|cutoff|first choice|placed|result|unmatched|notice|assistance|age|why.*get|why.*didn.t",
        lowered,
    )
    if coding_request and not re.search(r"intern|allocation|company|skill|profile|match", lowered):
        return True
    if allocation_terms:
        return False
    return not any(skill.lower() in lowered for skill in (known_skills or set()))


def unverified_numbers(answer: str, facts: dict, retrieved: list) -> list[str]:
    safe_text = re.sub(r"\[KB-\d+\]", "", answer)
    known_text = str(facts)
    for item in retrieved:
        known_text += " " + item.chunk.text + " " + item.chunk.title
    allowed = set(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?", known_text))
    found = set(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?", safe_text))
    unverified = sorted(found - allowed, key=lambda value: (float(value), value))
    if unverified:
        logger.warning("Assistant answer included %d unverified numeric token(s)", len(unverified))
    return unverified
