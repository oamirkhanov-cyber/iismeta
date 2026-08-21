FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    KB_MODE=1 \
    ENGINE=v2 \
    IISMETA_SUBJ_RESCUE=1 \
    IISMETA_SUBJ_RESCUE_SKIP_SB=08,09,34,46 \
    KB_DB_PATH=/app/0_БД_расценок/smeta_kb.sqlite

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/requirements.txt

COPY app/ /app/

RUN python -c "import gzip,shutil,os; p='/app/0_БД_расценок/smeta_kb.sqlite'; (shutil.copyfileobj(gzip.open(p+'.gz','rb'), open(p,'wb')), print('БД распакована', os.path.getsize(p)//1048576,'МБ')) if os.path.exists(p+'.gz') else print('gz не найден')"

RUN cd /app/_scripts/engine_v2 && KB_DB_PATH=/app/0_БД_расценок/smeta_kb.sqlite \
    python build_kb_slots.py 2>&1 | head -1 || echo "kb_slots НЕ собран — engine_v2 отдаст 503"

WORKDIR /app/_scripts

EXPOSE 8600
CMD uvicorn web_server:app --host 0.0.0.0 --port ${PORT:-8600}
