"""Socket protocol (CZ-26 §4): JSON-RPC 2.0, newline-delimited, socket mode 0600."""

import json
import os
import socket
import stat
import tempfile
import threading

import pytest

from czar_redact.redactor import Redactor
from czar_redact.server import SidecarServer, handle_frame


@pytest.fixture()
def server(redactor: Redactor):
    directory = tempfile.mkdtemp(prefix="czar-redact-")
    path = os.path.join(directory, "czar-redact.sock")
    srv = SidecarServer(path, redactor)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield path
    srv.shutdown()
    srv.server_close()


def call(path: str, payload: dict) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(path)
        client.sendall(json.dumps(payload).encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            data += client.recv(65536)
    return json.loads(data)


def test_socket_mode_is_0600(server: str) -> None:
    assert stat.S_IMODE(os.stat(server).st_mode) == 0o600


def test_analyze_anonymize_round_trip(server: str) -> None:
    reply = call(
        server,
        {"jsonrpc": "2.0", "id": 7, "method": "analyze_anonymize", "params": {"text": "mail kim@example.com", "language": "en"}},
    )
    assert reply["id"] == 7
    assert reply["result"]["text"] == "mail [[R:P:EMAIL_ADDRESS#1]]"
    assert reply["result"]["entities"] == [{"type": "EMAIL_ADDRESS", "count": 1}]


def test_errors_never_echo_text(redactor: Redactor) -> None:
    secret = "zoe@example.com"
    for frame in [b"not json " + secret.encode(), json.dumps({"jsonrpc": "2.0", "id": 1, "method": "x", "params": {"text": secret}}).encode()]:
        reply = handle_frame(redactor, frame)
        assert "error" in reply
        assert secret not in json.dumps(reply)


def test_unsupported_language_is_an_error(redactor: Redactor) -> None:
    reply = handle_frame(
        redactor,
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "analyze_anonymize", "params": {"text": "Hola", "language": "es"}}).encode(),
    )
    assert reply["error"]["code"] == -32010


def test_invalid_params(redactor: Redactor) -> None:
    reply = handle_frame(redactor, json.dumps({"jsonrpc": "2.0", "id": 3, "method": "analyze_anonymize", "params": {}}).encode())
    assert reply["error"]["code"] == -32602
