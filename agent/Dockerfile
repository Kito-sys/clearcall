FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
RUN adduser --disabled-password --gecos "" --home /home/appuser --uid 10001 appuser
WORKDIR /home/appuser/app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py .
USER appuser
CMD ["python", "agent.py", "start"]
