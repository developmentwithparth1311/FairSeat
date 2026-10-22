from dataclasses import dataclass
import os
from pathlib import Path
from dotenv import load_dotenv


REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


@dataclass(frozen=True)
class Settings:
    export_dir: Path = Path(os.getenv("SAE_EXPORT_DIR", REPO_ROOT / "exports"))
    kb_dir: Path = Path(os.getenv("KB_DIR", REPO_ROOT / "kb"))
    index_dir: Path = Path(os.getenv("INDEX_DIR", Path(__file__).resolve().parents[1] / ".index"))
    embed_model: str = os.getenv("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    llm_provider: str = os.getenv("LLM_PROVIDER", "mock")
    llm_model: str = os.getenv("LLM_MODEL", "")
    llm_api_key: str = os.getenv("GEMINI_API_KEY", "")
    top_k_chunks: int = int(os.getenv("TOP_K_CHUNKS", "4"))
    max_history_turns: int = int(os.getenv("MAX_HISTORY_TURNS", "2"))
    min_similarity: float = float(os.getenv("MIN_SIMILARITY", "0.25"))
    engine_runner_path: Path = Path(os.getenv("SAE_ENGINE_RUNNER_PATH", REPO_ROOT / "allocator_runner"))
    engine_policy_path: Path = Path(os.getenv("SAE_POLICY_PATH", REPO_ROOT / "config" / "allocation_policy_v2.conf"))
    admin_token: str = os.getenv("SAE_ADMIN_TOKEN", "")
    allow_real_data: bool = os.getenv("SAE_ALLOW_REAL_DATA", "0").strip().lower() in {"1", "true", "yes"}


settings = Settings()
