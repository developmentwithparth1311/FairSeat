import json
import logging
import re
import time

import httpx


logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


class MockLLM:
    """Deterministic, offline answerer used for demos and tests."""

    def generate(self, system: str, messages: list[dict]) -> str:
        del system
        content = messages[-1]["content"]
        fact_match = re.search(r"CANDIDATE FACTS\n(.*?)\n\nKNOWLEDGE\n", content, re.S)
        question_match = re.search(r"\n\nNEW QUESTION\n(.*)$", content, re.S)
        if not fact_match or not question_match:
            return "I don't have enough candidate facts to answer that."
        facts = json.loads(fact_match.group(1))
        question = question_match.group(1).strip()
        lowered = question.lower()
        candidate = facts["candidate"]
        outcome = facts["outcome"]
        choices = outcome["choices"]
        knowledge_refs = re.findall(r"\[(KB-\d+):", content)
        knowledge_entries = re.findall(
            r"\[(KB-\d+): kb/([^\]]+)\] (.*?) — (.*?)\n(.*?)(?=\n\[KB-\d+:|\n\nCHAT HISTORY|\Z)",
            content, re.S,
        )

        if re.search(r"\b(move|change|switch|give me|put me|assign)\b", lowered):
            return "I can't change an allocation, score, or seat. You can improve your profile skills or contact the official process about profile updates."

        if re.search(r"stipend|eligib|deadline|duration|application date|when does", lowered):
            return "I don't know that scheme detail from verified knowledge in this assistant. Please check the official PM Internship Scheme website or current official notices."

        if re.search(r"skill|learn|improv|what should i study|missing", lowered):
            missing = facts["skill_gap"]["missing_ranked"][:3]
            if not missing:
                return "Your exported top choices do not show a ranked missing skill. Review the company requirements and verified skill guides for a practical next step."
            skills = ", ".join(item["skill"] for item in missing)
            refs = f" See the relevant guide{'' if len(knowledge_refs) == 1 else 's'} {', '.join(f'[{r}]' for r in knowledge_refs)}." if knowledge_refs else ""
            if missing and knowledge_entries:
                target = missing[0]["skill"].replace(" ", "-").lower()
                guide = next((entry for entry in knowledge_entries
                              if entry[1].lower().startswith("skills/")
                              and (entry[1].lower().split("/")[-1].removesuffix(".md") == target
                                   or entry[2].lower().replace(" ", "-") == target)
                              and "get started" in entry[3].lower()), None)
                if guide:
                    steps = [line.strip() for line in guide[4].splitlines()
                             if re.match(r"\d+\.\s+", line.strip())][:3]
                    if steps:
                        return (
                            f"The most frequently requested skills missing from your relevant choices are {skills}. "
                            f"For {missing[0]['skill']}, start with: {' '.join(steps)} [{guide[0]}]."
                        )
            return f"The most frequently requested skills missing from your relevant choices are {skills}.{refs} Start with one skill, complete a small practice project, and add the result to your profile."

        if re.search(r"how does .*allocat|how .*allocation work|stable matching|what is .*cutoff", lowered):
            if knowledge_refs:
                return "The SAE allocation guide explains the score components, preference order, seats, and cutoff for this run. See " + ", ".join(f"[{ref}]" for ref in knowledge_refs) + "."
            return "I don't have a relevant allocation guide available right now. Please ask the SAE team for an explanation of the allocation process."

        if outcome["status"] == "unmatched":
            lost = [item for item in choices if item["outcome"] == "lost_seat"][:3]
            if not lost:
                return "Your exported result shows that you were unmatched. The available choice details don't include a final cutoff for a more specific comparison."
            comparisons = []
            for item in lost:
                if item["points_short"] is None:
                    comparisons.append(f"{item['company_name']} (score {item['score']})")
                else:
                    comparisons.append(
                        f"{item['company_name']} (score {item['score']}, cutoff {item['company_cutoff_score']}, "
                        f"short by {item['points_short']})"
                    )
            return "Your exported result shows that you were unmatched. The closest lost-seat comparisons are " + "; ".join(comparisons) + ". You could focus next on the missing skills shown in your skill-gap summary."

        if outcome["status"] == "matched":
            allocation = candidate["allocation"]
            company = next((item for item in choices if item["company_id"] == allocation["company_id"]), None)
            if re.search(r"first choice|first preference|top choice", lowered):
                first_choice = min(choices, key=lambda item: item["preference_rank"], default=None)
                if first_choice and first_choice["outcome"] == "lost_seat":
                    if first_choice["points_short"] is not None:
                        return (
                            f"Your first choice was {first_choice['company_name']}. Its outcome is lost_seat: "
                            f"your score was {first_choice['score']} and the final cutoff was "
                            f"{first_choice['company_cutoff_score']}, a difference of {first_choice['points_short']} points. "
                            f"Your exported result shows a match with {company['company_name']} at preference rank "
                            f"{allocation['preference_rank']}."
                        )
                    return f"Your first choice was {first_choice['company_name']}, but the exported data has no final cutoff to compare. You were matched with {company['company_name']}."
                if first_choice and first_choice["outcome"] == "not_reached":
                    return f"Your first choice was not reached because you were already placed at a more preferred company, {company['company_name']}."
            if company:
                guide = f" The allocation guide {', '.join(f'[{ref}]' for ref in knowledge_refs)} explains how preference order and company seats work." if knowledge_refs else ""
                return f"Your exported result shows a match with {company['company_name']} at preference rank {allocation['preference_rank']} and score {allocation['score']}. I can't change the placement.{guide}"
            return "Your exported result shows that you were matched. The matched company's details are not included in the available top choices."

        if knowledge_refs:
            return "I found relevant SAE guidance in " + ", ".join(f"[{ref}]" for ref in knowledge_refs) + ". " + "The retrieved guide explains the allocation process and current cutoff values are specific to this run."
        return "I don't know based on the candidate facts and retrieved knowledge available here. Please check the official scheme website for scheme policy details."


class AnthropicLLM:
    """Minimal Anthropic Messages API client, using httpx only."""

    endpoint = "https://api.anthropic.com/v1/messages"

    def __init__(self, api_key: str, model: str, timeout: float = 30.0):
        if not api_key:
            raise LLMError("LLM_API_KEY is required when LLM_PROVIDER=anthropic")
        if not model:
            raise LLMError("Set LLM_MODEL to an active Anthropic model when LLM_PROVIDER=anthropic")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def generate(self, system: str, messages: list[dict]) -> str:
        body = {
            "model": self.model,
            "max_tokens": 700,
            "system": system,
            "messages": messages,
        }
        headers = {
            "content-type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }
        for attempt in range(2):
            try:
                response = httpx.post(self.endpoint, headers=headers, json=body, timeout=self.timeout)
                if response.status_code == 429 or response.status_code >= 500:
                    if attempt == 0:
                        time.sleep(0.25)
                        continue
                    raise LLMError(f"Anthropic service returned HTTP {response.status_code}; please try again.")
                if response.status_code >= 400:
                    raise LLMError(f"Anthropic request was rejected (HTTP {response.status_code}); check the model and API settings.")
                payload = response.json()
                text = "".join(block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text")
                if not text.strip():
                    raise LLMError("Anthropic returned an empty answer; please try again.")
                return text.strip()
            except httpx.RequestError as exc:
                if attempt == 0:
                    time.sleep(0.25)
                    continue
                logger.warning("Anthropic request failed after retry (%s)", type(exc).__name__)
                raise LLMError("The language service could not be reached. Please try again later.") from exc
        raise LLMError("The language service could not complete the request.")


def create_llm(provider: str, api_key: str = "", model: str = ""):
    if provider == "mock":
        return MockLLM()
    if provider == "anthropic":
        return AnthropicLLM(api_key=api_key, model=model)
    raise LLMError(f"Unsupported LLM_PROVIDER: {provider}")
