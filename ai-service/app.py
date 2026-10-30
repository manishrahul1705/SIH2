import asyncio
import hmac
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr

logger = logging.getLogger("approvaltrack.ai")
OPERATIONS = frozenset({"ocr", "m1", "m2", "m3"})
MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 10 * 1024 * 1024
MAX_TIMEOUT_MS = 120_000
MAX_CONCURRENT_RUNS = 2


@dataclass(frozen=True)
class RuntimeConfig:
    model_root: Path
    upload_root: Path
    token: str
    environment: str
    python_bin: str

    def script_for(self, operation: str) -> Path:
        scripts = {
            "ocr": self.model_root / "Model1" / "ocr" / "ocr_extract.py",
            "m1": self.model_root / "Model1" / "m1_training" / "predict_m1.py",
            "m2": self.model_root / "Model2" / "ocr" / "m2_extract.py",
            "m3": self.model_root / "Model3" / "ocr" / "m3_extract.py",
        }
        return scripts[operation]


class InferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    args: list[StrictStr] = Field(max_length=8, default_factory=list)
    input: StrictStr = Field(default="", max_length=MAX_INPUT_BYTES)
    timeout_ms: int = Field(default=120_000, ge=100, le=MAX_TIMEOUT_MS)


class InferenceError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


def runtime_config() -> RuntimeConfig:
    project_root = Path(__file__).resolve().parents[1]
    return RuntimeConfig(
        model_root=Path(os.getenv("AI_MODEL_ROOT", project_root / "mlmodels")).resolve(),
        upload_root=Path(os.getenv("AI_UPLOAD_ROOT", project_root / "backend" / "uploads")).resolve(),
        token=os.getenv("AI_SERVICE_TOKEN", ""),
        environment=os.getenv("AI_SERVICE_ENV", "development"),
        python_bin=os.getenv("AI_PYTHON_BIN", sys.executable),
    )


def validate_invocation(operation: str, args: list[str], input_text: str, config: RuntimeConfig) -> list[str]:
    if operation not in OPERATIONS:
        raise InferenceError("AI_OPERATION_NOT_ALLOWED", "Requested model operation is not allowed")
    if len(input_text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise InferenceError("AI_INPUT_TOO_LARGE", "Model input exceeded the configured limit", 413)

    if operation == "m1":
        if args != ["--text-stdin"]:
            raise InferenceError("AI_ARGUMENTS_INVALID", "M1 accepts text from stdin only")
        return args

    if operation == "ocr":
        if len(args) != 1:
            raise InferenceError("AI_ARGUMENTS_INVALID", "OCR requires one uploaded file path")
        file_path = args[0]
    else:
        if (
            len(args) != 4
            or args[1] != "--doc-type"
            or args[3] != "--ocr-json-stdin"
            or not re.fullmatch(r"[A-Za-z0-9 _.-]{1,100}", args[2])
        ):
            raise InferenceError("AI_ARGUMENTS_INVALID", f"{operation.upper()} arguments are invalid")
        file_path = args[0]

    requested_path = Path(file_path).resolve()
    try:
        requested_path.relative_to(config.upload_root)
    except ValueError as error:
        raise InferenceError("AI_FILE_OUTSIDE_UPLOAD_ROOT", "Model input must be inside the upload directory", 403) from error
    if not requested_path.is_file():
        raise InferenceError("AI_FILE_NOT_FOUND", "Model input file was not found", 404)
    return [str(requested_path), *args[1:]]


def execute_inference(operation: str, payload: InferenceRequest, config: RuntimeConfig) -> dict:
    args = validate_invocation(operation, payload.args, payload.input, config)
    script = config.script_for(operation)
    if not script.is_file():
        raise InferenceError("AI_MODEL_UNAVAILABLE", "Configured model script is unavailable", 503)

    model_directories = [
        script.parent,
        config.model_root / "Model1" / "ocr",
        config.model_root / "Model2" / "ocr",
        config.model_root / "Model3" / "ocr",
    ]
    python_path = os.pathsep.join(str(item.resolve()) for item in model_directories if item.exists())
    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONPATH": os.pathsep.join(filter(None, [python_path, os.environ.get("PYTHONPATH", "")])),
        "M3_OCR_DIR": str((config.model_root / "Model1" / "ocr").resolve()),
    }

    try:
        result = subprocess.run(
            [config.python_bin, str(script), *args],
            input=payload.input,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=payload.timeout_ms / 1000,
            check=False,
            shell=False,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        raise InferenceError("PYTHON_TIMEOUT", "Model inference timed out", 504) from error
    except OSError as error:
        logger.error("Could not start model process: %s", error.__class__.__name__)
        raise InferenceError("PYTHON_START_FAILED", "Model inference could not start", 503) from error

    if len(result.stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise InferenceError("PYTHON_OUTPUT_TOO_LARGE", "Model output exceeded the configured limit", 502)
    if result.returncode not in ({0, 2} if operation == "m1" else {0}):
        logger.warning("Model %s exited with status %s", operation, result.returncode)
        raise InferenceError("PYTHON_EXIT_NONZERO", "Model inference failed", 502)
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise InferenceError("PYTHON_INVALID_JSON", "Model returned invalid JSON", 502) from error
    if not isinstance(value, dict):
        raise InferenceError("PYTHON_INVALID_JSON", "Model response must be a JSON object", 502)
    return value


def create_app(config: RuntimeConfig | None = None) -> FastAPI:
    runtime = config or runtime_config()
    if runtime.environment == "production" and not runtime.token:
        raise RuntimeError("AI_SERVICE_TOKEN must be configured in production")

    app = FastAPI(title="ApprovalTrack Local AI Service", version="1.0.0", docs_url=None, redoc_url=None)
    app.state.config = runtime
    app.state.inference_slots = asyncio.Semaphore(MAX_CONCURRENT_RUNS)

    @app.get("/health")
    async def health():
        scripts_available = all(runtime.script_for(operation).is_file() for operation in OPERATIONS)
        return JSONResponse(
            status_code=200 if scripts_available else 503,
            content={"status": "ok" if scripts_available else "degraded", "checks": {"modelScripts": "ok" if scripts_available else "unavailable"}},
        )

    @app.post("/v1/inference/{operation}")
    async def inference(
        operation: str,
        payload: InferenceRequest,
        request: Request,
        authorization: Annotated[str | None, Header(alias="X-AI-Service-Token")] = None,
    ):
        if runtime.token and not hmac.compare_digest(authorization or "", runtime.token):
            raise HTTPException(status_code=401, detail={"code": "AI_SERVICE_UNAUTHORIZED", "message": "Valid AI service credentials are required"})
        if operation not in OPERATIONS:
            raise HTTPException(status_code=404, detail={"code": "AI_OPERATION_NOT_ALLOWED", "message": "Requested model operation is not allowed"})

        started = time.monotonic()
        async with app.state.inference_slots:
            try:
                result = await asyncio.to_thread(execute_inference, operation, payload, runtime)
            except InferenceError as error:
                raise HTTPException(status_code=error.status, detail={"code": error.code, "message": str(error)}) from error
        logger.info("Model %s completed in %.3fs (request %s)", operation, time.monotonic() - started, request.headers.get("x-request-id", "unknown"))
        return result

    return app


app = create_app()
