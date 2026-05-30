FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends wget ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tts_server.py .

EXPOSE 8082

CMD ["uvicorn", "tts_server:app", "--host", "0.0.0.0", "--port", "8082"]
