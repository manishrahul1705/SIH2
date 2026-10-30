import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as ai_app


@pytest.fixture
def runtime(tmp_path):
    models = tmp_path / "models"
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    scripts = [
        models / "Model1" / "ocr" / "ocr_extract.py",
        models / "Model1" / "m1_training" / "predict_m1.py",
        models / "Model2" / "ocr" / "m2_extract.py",
        models / "Model3" / "ocr" / "m3_extract.py",
    ]
    for script in scripts:
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("print('{}')", encoding="utf-8")
    return ai_app.RuntimeConfig(
        model_root=models,
        upload_root=uploads.resolve(),
        token="test-service-token",
        environment="test",
        python_bin=sys.executable,
    )


def test_health_reports_model_availability(runtime):
    with TestClient(ai_app.create_app(runtime)) as client:
        healthy = client.get("/health")
        runtime.script_for("m3").unlink()
        unavailable = client.get("/health")
    assert healthy.status_code == 200
    assert healthy.json() == {"status": "ok", "checks": {"modelScripts": "ok"}}
    assert unavailable.status_code == 503
    assert unavailable.json() == {"status": "degraded", "checks": {"modelScripts": "unavailable"}}


def test_production_requires_service_token(tmp_path):
    with pytest.raises(RuntimeError, match="AI_SERVICE_TOKEN"):
        ai_app.create_app(ai_app.RuntimeConfig(tmp_path, tmp_path, "", "production", sys.executable))


def test_m1_is_restricted_to_stdin_and_enforces_utf8_byte_limit(runtime):
    assert ai_app.validate_invocation("m1", ["--text-stdin"], "college report", runtime) == ["--text-stdin"]
    with pytest.raises(ai_app.InferenceError, match="M1 accepts text"):
        ai_app.validate_invocation("m1", ["--text-stdin", "extra"], "", runtime)
    with pytest.raises(ai_app.InferenceError) as error:
        ai_app.validate_invocation("m1", ["--text-stdin"], "é" * (ai_app.MAX_INPUT_BYTES // 2 + 1), runtime)
    assert error.value.code == "AI_INPUT_TOO_LARGE"


def test_file_models_cannot_read_outside_shared_upload_root(runtime, tmp_path):
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-")
    with pytest.raises(ai_app.InferenceError) as error:
        ai_app.validate_invocation("ocr", [str(outside)], "", runtime)
    assert error.value.code == "AI_FILE_OUTSIDE_UPLOAD_ROOT"


def test_remote_inference_requires_token_and_returns_model_json(runtime, monkeypatch):
    script = runtime.script_for("m1")
    monkeypatch.setattr(
        ai_app.subprocess,
        "run",
        lambda command, **options: SimpleNamespace(returncode=0, stdout=json.dumps({"value": "fire", "confidence": 0.95}), stderr=""),
    )
    client = TestClient(ai_app.create_app(runtime))
    unauthorized = client.post("/v1/inference/m1", json={"args": ["--text-stdin"], "input": "text"})
    assert unauthorized.status_code == 401

    response = client.post(
        "/v1/inference/m1",
        headers={"X-AI-Service-Token": runtime.token},
        json={"args": ["--text-stdin"], "input": "text"},
    )
    assert response.status_code == 200
    assert response.json() == {"value": "fire", "confidence": 0.95}
    assert script.is_file()


def test_file_inference_uses_fixed_script_and_safe_arguments(runtime, monkeypatch):
    uploaded_file = runtime.upload_root / "permit.pdf"
    uploaded_file.write_bytes(b"%PDF-test")
    calls = []

    def fake_run(command, **options):
        calls.append((command, options))
        return SimpleNamespace(returncode=0, stdout='{"supported": true}', stderr="")

    monkeypatch.setattr(ai_app.subprocess, "run", fake_run)
    payload = ai_app.InferenceRequest(args=[str(uploaded_file), "--doc-type", "fire", "--ocr-json-stdin"], input="{}")
    result = ai_app.execute_inference("m2", payload, runtime)

    assert result == {"supported": True}
    command, options = calls[0]
    assert command[0] == runtime.python_bin
    assert command[1] == str(runtime.script_for("m2"))
    assert command[2:] == [str(uploaded_file), "--doc-type", "fire", "--ocr-json-stdin"]
    assert options["shell"] is False
    assert options["input"] == "{}"
