#!/usr/bin/env python3
"""Morrow local TTS sidecar: Qwen3-TTS CustomVoice, one model load per app session."""
from __future__ import annotations

import argparse
import io
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

LOCK = threading.Lock()
MODEL = None
MODEL_LABEL = "Qwen3-TTS CustomVoice"


def log(message: str) -> None:
    print(f"[morrow-tts] {message}", flush=True)


class Handler(BaseHTTPRequestHandler):
    token = ""

    def log_message(self, _format, *args):  # noqa: N802
        return

    def _authorized(self) -> bool:
        return self.headers.get("Authorization", "") == f"Bearer {self.token}"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        self._json(200, {"ok": True, "model": MODEL_LABEL})

    def do_POST(self):  # noqa: N802
        if self.path != "/synthesize":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2 * 1024 * 1024:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            if not text:
                raise ValueError("text 不能为空")
            speaker = str(payload.get("speaker") or "Vivian").strip()
            instruct = str(payload.get("instruct") or "").strip()
            with LOCK, torch.inference_mode():
                wavs, sample_rate = MODEL.generate_custom_voice(
                    text=text[:1200],
                    language="Chinese",
                    speaker=speaker,
                    instruct=instruct or None,
                )
            buffer = io.BytesIO()
            sf.write(buffer, wavs[0], sample_rate, format="WAV")
            data = buffer.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:  # keep the sidecar alive for the next line
            log(f"synthesize failed: {exc}")
            self._json(500, {"error": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    log(f"loading model from {args.model}")
    global MODEL, MODEL_LABEL
    MODEL = Qwen3TTSModel.from_pretrained(
        args.model,
        device_map="cuda:0" if torch.cuda.is_available() else "cpu",
        dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
    )
    try:
        speakers = MODEL.get_supported_speakers()
        if speakers:
            log(f"speakers: {', '.join(speakers)}")
    except Exception:
        pass
    MODEL_LABEL = f"Qwen3-TTS · {args.model}"
    Handler.token = args.token
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    port = server.server_address[1]
    print(f"MORROW_TTS_PORT={port}", flush=True)
    log(f"ready on {args.host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
