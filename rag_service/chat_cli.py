import argparse
import os
import uuid

import httpx


def main() -> int:
    parser = argparse.ArgumentParser(description="Chat with the SAE candidate assistant")
    parser.add_argument("--candidate", required=True, help="Candidate ID from the SAE export")
    parser.add_argument("--api", default=os.getenv("SAE_API_URL", "http://127.0.0.1:8000"))
    args = parser.parse_args()
    base_url = args.api.rstrip("/")
    session_id = str(uuid.uuid4())

    print(f"SAE assistant for candidate {args.candidate}. Type /summary, /gap, or /quit.")
    with httpx.Client(timeout=35.0) as client:
        try:
            health = client.get(f"{base_url}/health").json()
        except httpx.HTTPError:
            health = {}
        external_processing = health.get("external_llm_processing")
        if external_processing:
            print(f"Privacy notice: {health.get('privacy_notice', 'Candidate facts and chat text may be sent to Gemini.')}")
        consent_requested = False
        external_consent = False
        while True:
            try:
                message = input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if not message:
                continue
            if message == "/quit":
                return 0
            if message == "/summary":
                response = client.get(f"{base_url}/candidates/{args.candidate}/summary")
                if response.is_success:
                    print(response.json())
                else:
                    print(f"Request failed ({response.status_code}): {response.text}")
                continue
            if message == "/gap":
                response = client.get(f"{base_url}/candidates/{args.candidate}/skill-gap")
                if response.is_success:
                    print(response.json())
                else:
                    print(f"Request failed ({response.status_code}): {response.text}")
                continue

            if external_processing is not False and not external_consent:
                if consent_requested:
                    print("External processing was declined; no chat message was sent.")
                    continue
                consent_requested = True
                if input("This chat may send minimized candidate facts and your question to Gemini. Type yes to continue: ").strip().lower() != "yes":
                    print("Declined. No chat message was sent.")
                    continue
                external_consent = True

            try:
                response = client.post(f"{base_url}/chat", json={
                    "candidate_id": args.candidate,
                    "session_id": session_id,
                    "message": message,
                })
            except httpx.HTTPError as exc:
                print(f"Could not reach the assistant: {exc}")
                continue
            if not response.is_success:
                print(f"Request failed ({response.status_code}): {response.text}")
                continue
            payload = response.json()
            print(f"Assistant: {payload['answer']}")
            if payload.get("sources"):
                print("Sources:")
                for source in payload["sources"]:
                    print(f"- [{source['label']}] {source['title']} ({source['path']})")
                    for url in source.get("urls", []):
                        print(f"  {url}")
            print(payload.get("disclaimer", ""))


if __name__ == "__main__":
    raise SystemExit(main())
