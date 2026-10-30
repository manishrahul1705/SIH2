# ApprovalTrack local AI service

This FastAPI service provides an optional isolated HTTP boundary for the
existing OCR, M1, M2, and M3 command-line models. The backend uses the current
local-process bridge unless `AI_SERVICE_URL` is configured.

## Local setup

From the repository root, install the service and model dependencies:

```powershell
python -m pip install -r .\ai-service\requirements.txt
python -m pip install -r .\mlmodels\Model1\ocr\requirements.txt
python -m pip install -r .\mlmodels\Model1\m1_training\requirements.txt
```

Install the Tesseract executable and English/Hindi language data separately.
Python packages do not install the Tesseract binary.

Start the service from the repository root:

```powershell
$env:AI_MODEL_ROOT = (Resolve-Path .\mlmodels).Path
$env:AI_UPLOAD_ROOT = (Resolve-Path .\backend\uploads).Path
$env:AI_SERVICE_TOKEN = "use-a-long-random-service-token"
python -m uvicorn app:app --app-dir .\ai-service --host 127.0.0.1 --port 8001
```

Configure the backend with the same upload directory and service token:

```text
UPLOAD_DIR=./uploads
AI_SERVICE_URL=http://127.0.0.1:8001
AI_SERVICE_TOKEN=<same random token>
```

The backend and AI service must see every uploaded file at the same absolute
path. For containers, mount one private shared upload volume at the identical
container path for both services. Do not publish the AI service outside the
private application network. Production service startup requires a token, and
the production backend requires a token whenever `AI_SERVICE_URL` is set.

## Interface and controls

- `GET /health` checks that all four configured model scripts exist.
- `POST /v1/inference/ocr`, `/m1`, `/m2`, or `/m3` accepts a bounded JSON
  request and returns the model's JSON object.
- Only fixed model scripts and their documented argument shapes are accepted;
  shell execution is disabled.
- OCR/M2/M3 input files must resolve inside `AI_UPLOAD_ROOT`.
- The service limits concurrent model runs, input/output sizes, and runtime.
- The service token is compared in constant time. Request bodies and model text
  are not logged.

This service isolates model execution but does not itself provide Docker
Compose orchestration, Redis/BullMQ workers, MinIO storage, or Nginx routing.
