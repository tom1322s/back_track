FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Demucs model so the first separation is fast.
# htdemucs is the default 4-stem model (~80MB).
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

# Pre-download the BTC chord-recognition model (best-effort: a network hiccup
# here must not fail the build — the app lazy-loads + falls back at runtime).
RUN python -c "from transformers import AutoModel; AutoModel.from_pretrained('puar-playground/btc-chord', trust_remote_code=True)" \
    || echo "BTC pre-download skipped; will load at runtime"

COPY app ./app

RUN mkdir -p /data/uploads /data/stems
ENV BACKTRACK_DATA_DIR=/data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
