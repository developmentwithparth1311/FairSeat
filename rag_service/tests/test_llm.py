import httpx
import pytest

from app.llm import GeminiLLM, LLMError, create_llm


def test_provider_config_errors_are_friendly():
    with pytest.raises(LLMError, match="GEMINI_API_KEY"):
        create_llm("gemini", "", "model")
    with pytest.raises(LLMError, match="LLM_MODEL"):
        create_llm("gemini", "secret-test-key", "")
    with pytest.raises(LLMError, match="Unsupported"):
        create_llm("unknown")


def test_gemini_retries_transient_error_and_extracts_text(monkeypatch):
    responses = [
        httpx.Response(503, json={"error": {"message": "busy"}}),
        httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "Grounded answer."}]}}]}),
    ]
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return responses.pop(0)

    monkeypatch.setattr("app.llm.httpx.post", fake_post)
    llm = GeminiLLM("secret-test-key", "test-model")
    assert llm.generate("rules", [{"role": "user", "content": "hello"}]) == "Grounded answer."
    assert len(calls) == 2
    assert calls[0][1]["timeout"] == 30.0
    assert calls[0][0].endswith("/models/test-model:generateContent")
    assert calls[0][1]["headers"]["x-goog-api-key"] == "secret-test-key"
    assert calls[0][1]["json"]["systemInstruction"]["parts"][0]["text"] == "rules"
