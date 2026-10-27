"""``czar-redact`` JSON-RPC 2.0 server on a Unix socket, newline-delimited frames (CZ-26 §4).

One method: ``analyze_anonymize {text, language, entities?} -> {text, entities: [{type, count}]}``.
The socket is created with mode 0600. The helper keeps no state, writes no files and opens no network
connection (CZ-26 §8, §9). Logs carry counts only, never text.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import socketserver
import stat
import sys
from typing import Any

from czar_redact.redactor import Redactor, UnsupportedLanguageError

METHOD = "analyze_anonymize"
SOCKET_MODE = 0o600
MAX_FRAME_BYTES = 1_048_576

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNSUPPORTED_LANGUAGE = -32010


def handle_frame(redactor: Redactor, frame: bytes) -> dict[str, Any]:
    try:
        request = json.loads(frame)
    except (ValueError, UnicodeDecodeError):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": "parse error"}}
    request_id = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INVALID_REQUEST, "message": "invalid request"}}
    if request["method"] != METHOD:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": METHOD_NOT_FOUND, "message": "method not found"}}
    params = request.get("params")
    if (
        not isinstance(params, dict)
        or not isinstance(params.get("text"), str)
        or not isinstance(params.get("language"), str)
        or not (params.get("entities") is None or isinstance(params.get("entities"), list))
    ):
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INVALID_PARAMS, "message": "invalid params"}}
    try:
        result = redactor.redact(params["text"], params["language"], params.get("entities"))
    except UnsupportedLanguageError:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": UNSUPPORTED_LANGUAGE, "message": "unsupported language"},
        }
    except Exception:  # never echo text or internals back
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INTERNAL_ERROR, "message": "internal error"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": {"text": result.text, "entities": result.entities}}


class _Handler(socketserver.StreamRequestHandler):
    server: "SidecarServer"

    def handle(self) -> None:
        while True:
            frame = self.rfile.readline(MAX_FRAME_BYTES + 1)
            if not frame:
                return
            if len(frame) > MAX_FRAME_BYTES:
                return
            if frame.strip() == b"":
                continue
            reply = handle_frame(self.server.redactor, frame)
            self.wfile.write(json.dumps(reply).encode("utf-8") + b"\n")
            self.wfile.flush()


class SidecarServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, redactor: Redactor) -> None:
        self.redactor = redactor
        if os.path.exists(path):
            if not stat.S_ISSOCK(os.lstat(path).st_mode):
                raise RuntimeError("socket path exists and is not a socket")
            os.unlink(path)
        previous = os.umask(0o177)
        try:
            super().__init__(path, _Handler)
        finally:
            os.umask(previous)
        os.chmod(path, SOCKET_MODE)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="czar-redact")
    parser.add_argument("--socket", required=True, help="path of czar-redact.sock")
    args = parser.parse_args(argv)
    server = SidecarServer(args.socket, Redactor())
    sys.stderr.write("czar-redact ready\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if os.path.exists(args.socket):
            os.unlink(args.socket)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
