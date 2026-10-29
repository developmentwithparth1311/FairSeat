"""Opt-in provider connectivity check using a fixed, non-personal prompt."""

import os
import sys

from app.config import settings
from app.llm import LLMError, create_llm


def main() -> int:
    if os.getenv("SAE_LIVE_LLM") != "1":
        print("Live call not made. Set SAE_LIVE_LLM=1 to explicitly opt in.", file=sys.stderr)
        return 2
    if settings.llm_provider == "mock":
        print("Set LLM_PROVIDER to gemini or groq in rag_service/.env before opting in.", file=sys.stderr)
        return 2
    try:
        llm = create_llm(settings.llm_provider, settings.llm_api_key, settings.llm_model)
        llm.generate(
            "Reply with exactly: SAE provider connectivity check succeeded.",
            [{"role": "user", "content": "SAE provider connectivity check. Do not add any other text."}],
        )
    except LLMError as exc:
        print(f"{settings.llm_provider} connectivity check failed: {exc}", file=sys.stderr)
        return 1
    print(f"{settings.llm_provider} connectivity check succeeded. No candidate data was sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
