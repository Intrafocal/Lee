import hashlib
import json
import os
import uuid

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from hester.shared import auth


def write_device(directory, device_id, token, revoked_at=None, kind="aeronaut"):
    directory.mkdir(parents=True, exist_ok=True)
    rec = {
        "device_id": device_id,
        "name": f"{device_id} phone",
        "kind": kind,
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "created_at": "2026-09-25T14:00:00.000Z",
        "last_seen_at": None,
        "last_ip": "192.168.1.23",
        "paired_via": "qr",
        "revoked_at": revoked_at,
    }
    path = directory / f"{device_id}.json"
    path.write_text(json.dumps(rec))
    return path


def bump(path):
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


def test_valid_unknown_revoked(tmp_path):
    d = tmp_path / "devices"
    token = str(uuid.uuid4())
    other = str(uuid.uuid4())
    write_device(d, "dev_000000000001", token)
    write_device(d, "dev_000000000002", other, revoked_at="2026-09-25T15:00:00.000Z")
    (d / "dev_broken.json").write_text("{nope")

    rec = auth.device_for_token(token, d)
    assert rec["device_id"] == "dev_000000000001"
    assert rec["kind"] == "aeronaut"
    assert "token_sha256" not in rec

    assert auth.device_for_token(other, d) is None
    assert auth.device_for_token(str(uuid.uuid4()), d) is None
    assert auth.device_for_token("", d) is None
    assert auth.device_for_token(None, d) is None
    assert auth.device_for_token("ünïcode", d) is None
    assert auth.device_for_token(token, tmp_path / "missing") is None


def test_mtime_cache(tmp_path, monkeypatch):
    d = tmp_path / "devices"
    token = str(uuid.uuid4())
    path = write_device(d, "dev_000000000003", token)

    loads = []
    real = auth._load_device_records
    monkeypatch.setattr(auth, "_load_device_records", lambda directory: loads.append(1) or real(directory))

    assert auth.device_for_token(token, d) is not None
    assert auth.device_for_token(token, d) is not None
    assert len(loads) == 1

    write_device(d, "dev_000000000003", token, revoked_at="2026-09-25T16:00:00.000Z")
    bump(path)
    assert auth.device_for_token(token, d) is None
    assert len(loads) == 2

    new_token = str(uuid.uuid4())
    write_device(d, "dev_000000000004", new_token)
    assert auth.device_for_token(new_token, d)["device_id"] == "dev_000000000004"
    assert len(loads) == 3


@pytest.fixture
def daemon_app(tmp_path, monkeypatch):
    import hester.daemon.main as main

    devices = tmp_path / "devices"
    monkeypatch.setenv("LEE_API_TOKEN", "shared-secret")
    monkeypatch.delenv("HESTER_AUTH_DISABLED", raising=False)
    monkeypatch.setattr(main, "device_for_token", lambda t: auth.device_for_token(t, devices))

    if not any(getattr(r, "path", None) == "/__test/principal" for r in main.app.router.routes):
        @main.app.get("/__test/principal")
        async def _principal(request: Request):
            return {"principal": request.state.principal}

    return main.app, devices


def test_middleware_accepts_shared_and_device_tokens(daemon_app):
    app, devices = daemon_app
    token = str(uuid.uuid4())
    path = write_device(devices, "dev_00000000000a", token, kind="dirigible")
    client = TestClient(app)

    r = client.get("/__test/principal", headers={"Authorization": "Bearer shared-secret"})
    assert r.status_code == 200
    assert r.json()["principal"] == {"kind": "shared"}

    r = client.get("/__test/principal", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["principal"] == {
        "kind": "device", "device_id": "dev_00000000000a", "device_kind": "dirigible", "name": "dev_00000000000a phone",
    }

    r = client.get(f"/__test/principal?token={token}")
    assert r.status_code == 200

    assert client.get("/__test/principal", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/__test/principal").status_code == 401

    write_device(devices, "dev_00000000000a", token, revoked_at="2026-09-25T16:00:00.000Z", kind="dirigible")
    bump(path)
    assert client.get("/__test/principal", headers={"Authorization": f"Bearer {token}"}).status_code == 401
