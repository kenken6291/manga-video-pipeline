# ローカル常駐レンダラー（RENDER_MODE=local 用）
#   docker build -t manga-renderer -f renderer/Dockerfile .
#   docker run --env-file renderer/.env manga-renderer
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY renderer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY renderer/ .
CMD ["python", "render.py", "--poll"]
