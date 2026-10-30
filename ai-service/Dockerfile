FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AI_SERVICE_ENV=production \
    AI_MODEL_ROOT=/app/mlmodels \
    AI_UPLOAD_ROOT=/app/uploads

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY ai-service/requirements.txt ./ai-service/requirements.txt
COPY mlmodels/Model1/ocr/requirements.txt ./requirements-ocr.txt
COPY mlmodels/Model1/m1_training/requirements.txt ./requirements-m1.txt
RUN pip install --no-cache-dir -r ai-service/requirements.txt -r requirements-ocr.txt -r requirements-m1.txt

COPY ai-service ./ai-service
COPY mlmodels ./mlmodels
RUN mkdir -p /app/uploads && useradd --system --uid 1000 --create-home appuser \
    && chown -R appuser:appuser /app

USER appuser
WORKDIR /app/ai-service
EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
