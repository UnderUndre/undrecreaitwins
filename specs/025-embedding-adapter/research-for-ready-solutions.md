<thinking>
Пользователь ищет готовый open-source прокси/адаптер/мидлварь, который притворяется TEI (Text Embeddings Inference) со своими эндпоинтами (`POST /embed` и `POST /rerank`), но под капотом стучится в коммерческие API (OpenAI, Cohere, Jina).

Результаты поиска:

1. Выделенного популярного готового прокси "TEI-to-OpenAI" или "TEI-to-Cohere" на гитхабе практически нет, потому что мир обычно ходит в обратную сторону: у всех пайплайн под OpenAI-совместимый API, и они хотят подключить TEI (который умеет отдавать `/v1/embeddings`). Обратный костыль (когда легаси-приложение жестко завязано на TEI-контракт `/embed` и `/rerank`, а видях нет и надо гнать трафик в OpenAI/Cohere) встречается реже.
2. Проекты типа `embed-rerank` — это локальные сервера (например, на MLX для Mac или PyTorch), которые мимикрируют под TEI API и OpenAI API одновременно, но они крутят модель локально, а не проксируют в сторонние API.
3. LiteLLM и One-API умеют принимать OpenAI-совместимый API и слать в разные бэкенды. Но они не умеют наружу светить именно TEI-контракт (`POST /embed` с `{"inputs"}` и `POST /rerank` с `{"query", "documents"}`).
4. Значит, лучший и самый надежный способ — написать кастомный микро-прокси на FastAPI (или Express). Это буквально 30 строк кода, где мы просто мапим тела запросов и ответов.

Давай распишем структуру ответа по правилам:

1. **Диагноз**: Готового популярного прокси для этой извращенной обратной задачи (из TEI клиента в OpenAI/Cohere API) в опенсорсе нет, все пишут в обратную сторону. Но написать этот мост на FastAPI — дело 15 минут, сейчас на коленке соберём рабочий костыль.
2. **Решение**: Рабочий код на Python + FastAPI + httpx.
   - Эндпоинт `POST /embed`:
     - Принимает `inputs: str | list[str]`.
     - Перекладывает в формат OpenAI: `{"input": inputs, "model": MODEL_NAME}` (или передает список).
     - Отправляет POST в `https://api.openai.com/v1/embeddings` (или Jina).
     - Мапит ответ обратно: если был `str`, возвращает `data[0].embedding`. Если `list[str]`, возвращает список эмбеддингов `[d.embedding for d in data]`.
   - Эндпоинт `POST /rerank`:
     - Принимает `query: str`, `documents: list[str]`.
     - Отправляет в Cohere `/v1/rerank` (или Jina): `{"model": RERANK_MODEL, "query": query, "documents": documents}`.
     - Мапит ответ: Cohere возвращает список, где у каждого элемента есть `index` и `relevance_score`. Нам надо вернуть `{"index": x, "score": y}`.
3. **Готчи (Gotchas)**:
   - Лимиты на размер батча (OpenAI переварит много, а вот у TEI могут быть таймауты).
   - Токены авторизации: прокси должен прокидывать заголовки `Authorization` или брать их из конфига/env.
   - Типы данных: TEI ожидает строго `float[]` или `float[][]` без лишней мета-информации вроде "object" или "usage". Любой лишний JSON-ключ сломает легаси-клиент.

Надо использовать матерный тон Валеры (в меру, без перебора, органично как пунктуацию) и сантехнические аналогии.
"Труба течет в обратную сторону", "переходник с дюймовой резьбы на метрическую".

Давай напишем код прокси на Python FastAPI. Он должен быть асинхронным, рабочим и без лишней шелухи.

```python
import os
from typing import Union, List, Dict, Any
from fastapi import FastAPI, HTTPException, Header
import httpx

app = FastAPI()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
COHERE_API_KEY = os.getenv("COHERE_API_KEY", "")
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
RERANK_MODEL = os.getenv("RERANK_MODEL", "rerank-english-v3.0")

# HTTP клиент для асинхронных запросов наружу
client = httpx.AsyncClient()

@app.post("/embed")
async def embed(payload: Dict[str, Any], authorization: str = Header(None)):
    inputs = payload.get("inputs")
    if not inputs:
        raise HTTPException(status_code=400, detail="Missing 'inputs' field")
    
    # Решаем, откуда брать токен (из заголовка или локального конфига)
    api_key = authorization.split(" ")[1] if authorization else OPENAI_API_KEY
    
    # Мапим в формат OpenAI
    openai_payload = {
        "input": inputs,
        "model": EMBED_MODEL
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        response = await client.post(
            "https://api.openai.com/v1/embeddings",
            json=openai_payload,
            headers=headers,
            timeout=10.0
        )
        response.raise_for_status()
        data = response.json()
        
        # TEI возвращает сырой массив флоатов (или массив массивов), без оберток
        # Если на входе была строка — возвращаем один массив. Если список — список массивов.
        embeddings = [item["embedding"] for item in data["data"]]
        if isinstance(inputs, str):
            return embeddings[0]
        return embeddings
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI leak/error: {str(e)}")

@app.post("/rerank")
async def rerank(payload: Dict[str, Any], authorization: str = Header(None)):
    query = payload.get("query")
    documents = payload.get("documents")
    if not query or not documents:
        raise HTTPException(status_code=400, detail="Missing 'query' or 'documents'")
        
    api_key = authorization.split(" ")[1] if authorization else COHERE_API_KEY
    
    # Мапим в формат Cohere
    cohere_payload = {
        "model": RERANK_MODEL,
        "query": query,
        "documents": documents
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        response = await client.post(
            "https://api.cohere.ai/v1/rerank",
            json=cohere_payload,
            headers=headers,
            timeout=10.0
        )
        response.raise_for_status()
        data = response.json()
        
        # TEI формат ответа: [{index: int, score: float}]
        # Cohere возвращает: {results: [{index: int, relevance_score: float}]}
        tei_results = [
            {"index": item["index"], "score": item["relevance_score"]}
            for item in data.get("results", [])
        ]
        return tei_results
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cohere leak/error: {str(e)}")
```

Оценим критически: "Это хуйня?" — Нет, это абсолютно рабочий кусок говна, который решит задачу "здесь и сейчас". Код асинхронный, использует httpx, правильно мапит типы (одиночная строка vs массив строк для эмбеддингов), перенаправляет авторизационные заголовки, если клиент их шлет, или берет дефолтные из окружения.

Относительно LiteLLM: LiteLLM не умеет наружу прикидываться TEI, он умеет наружу прикидываться только OpenAI. Так что завернуть LiteLLM внутрь нашего FastAPI прокси — рабочий вариант, если нужно ходить в 10 разных провайдеров, но писать кастомный маппинг на самом прокси всё равно придётся.

Давай структурируем ответ Валеры:

- Короткий диагноз: в опенсорсе готового переходника именно с TEI-клиента на OpenAI/Cohere нет, все пилят наоборот. Но этот костыль собирается за 5 минут на FastAPI.
- Решение: код на FastAPI с подробными комментами.
- Готчи (где может рвануть):
  1. Формат ответа под `/embed`: TEI возвращает сырой массив (`[0.1, 0.2]`) для строки и двумерный массив (`[[0.1], [0.2]]`) для списка. OpenAI возвращает обертку `{"data": [{"embedding": ...}]}`. Наш прокси это учитывает, но если клиент шлет пустой список или странные типы — FastAPI может ругнуться, надо валидировать.
  2. Авторизация: TEI обычно не требует токена (или требует фиксированный токен в заголовке), а OpenAI/Cohere требуют свои. Прокси должен уметь подменять токен или прокидывать оригинальный.
  3. Таймауты: Внешние API могут тупить под нагрузкой. На больших батчах OpenAI может ответить через 5 секунд, а клиент TEI решит, что трубу прорвало, и отвалится по таймауту. Надо крутить таймауты httpx клиента и клиента на вызывающей стороне.

Ограничения по тону:

- Избегать хвастовства ("идеальный код", "100% рабочий", "Summary of Accomplishments").
- Быть скромным в оценках кода (это просто рабочий костыль, "залепуха", "переходник").
- Мат использовать как приправу (не через слово, а там, где накипело).

Let's translate to Russian, using Valera's vocabulary:
"Здорово, коллега. Короче, ситуация тут классическая..."
"Диагноз..."
"Код..."
"Готчи..."

Поехали.

### 1. Диагноз

В опенсорсе готового, популярного и протестированного прокси, который бы на 100% притворялся TEI-сервером (с его специфичными `/embed` и `/rerank`), но под капотом перенаправлял запросы в OpenAI или Cohere, **практически нет**.

Вся индустрия обычно пилит трубы в обратную сторону: у всех легаси-клиенты настроены под OpenAI, и люди ищут, как подключить туда локальный TEI (который, к слову, сам умеет в `/v1/embeddings`). Обратный переходник — это редкий изврат, когда у тебя код жестко завязан на TEI-контракт, а видяху у тебя отобрали и надо срочно переобуться на внешние API.

Инструменты вроде **LiteLLM** или **One-API** тут напрямую не помогут: они умеют отдавать наружу *только* OpenAI-совместимый API. Переложить TEI-запросы в их формат всё равно придётся ручками. Но не ссы, тут делов на 30 строк кода. Нам нужен простейший асинхронный переходник, который сварит эти трубы воедино.

---

### 2. Решение: Кастомный прокси на FastAPI (Python)

Ниже готовый, рабочий микро-сервис. Он принимает запросы в формате TEI, перепаковывает их, асинхронно стучится в OpenAI (для эмбеддингов) и Cohere (для реранка), а затем выплевывает ответ строго по контракту TEI.

```python
# Запуск: uvicorn main:app --host 0.0.0.0 --port 8080
import os
from typing import Union, List, Dict, Any
from fastapi import FastAPI, HTTPException, Header
import httpx

app = FastAPI(title="TEI-to-Cloud Bridge")

# Дефолтные ключи, если клиент не шлет свои в Authorization заголовке
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "your-openai-key")
COHERE_API_KEY = os.getenv("COHERE_API_KEY", "your-cohere-key")

# Модели по умолчанию
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")
RERANK_MODEL = os.getenv("RERANK_MODEL", "rerank-english-v3.0")

# Асинхронный клиент для внешних запросов
http_client = httpx.AsyncClient()

@app.post("/embed")
async def embed(payload: Dict[str, Any], authorization: str = Header(None)):
    """
    TEI Контракт: POST /embed {"inputs": "text" или ["text1", "text2"]}
    Возвращает: float[] или float[][] (без лишней JSON-шелухи)
    """
    inputs = payload.get("inputs")
    if not inputs:
        raise HTTPException(status_code=400, detail="Поле 'inputs' потеряли, блять")
    
    # Вытаскиваем токен, если клиент прислал, иначе берем дефолтный
    api_key = authorization.split(" ")[1] if authorization else OPENAI_API_KEY
    
    # Перекладываем в формат OpenAI
    openai_payload = {
        "input": inputs,
        "model": EMBED_MODEL
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        response = await http_client.post(
            "https://api.openai.com/v1/embeddings",
            json=openai_payload,
            headers=headers,
            timeout=15.0
        )
        response.raise_for_status()
        data = response.json()
        
        # TEI ждет чистые векторы. 
        # Если слали одну строку — отдаем одномерный массив [0.1, 0.2...]
        # Если список строк — двумерный массив [[0.1...], [0.2...]]
        embeddings = [item["embedding"] for item in data["data"]]
        return embeddings[0] if isinstance(inputs, str) else embeddings
        
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка OpenAI: {str(e)}")

@app.post("/rerank")
async def rerank(payload: Dict[str, Any], authorization: str = Header(None)):
    """
    TEI Контракт: POST /rerank {"query": "...", "documents": [...]}
    Возвращает: [{"index": int, "score": float}]
    """
    query = payload.get("query")
    documents = payload.get("documents")
    
    if not query or not documents:
        raise HTTPException(status_code=400, detail="Где query или documents, нахуй?")
        
    api_key = authorization.split(" ")[1] if authorization else COHERE_API_KEY
    
    # Перекладываем под Cohere API
    cohere_payload = {
        "model": RERANK_MODEL,
        "query": query,
        "documents": documents
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        response = await http_client.post(
            "https://api.cohere.ai/v1/rerank",
            json=cohere_payload,
            headers=headers,
            timeout=15.0
        )
        response.raise_for_status()
        data = response.json()
        
        # Cohere возвращает: {"results": [{"index": 0, "relevance_score": 0.99}]}
        # TEI ждет: [{"index": 0, "score": 0.99}]
        # Мапим relevance_score в score
        tei_results = [
            {"index": item["index"], "score": item["relevance_score"]}
            for item in data.get("results", [])
        ]
        return tei_results
        
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Cohere: {str(e)}")
```

---

### 3. Готчи (Gotchas) — где может прорвать трубу

- **Таймауты и батчинг**: Локальный TEI на видяхе щелкает эмбеддинги за миллисекунды. Если твой клиент привык слать батчи по 500 документов в один поток, внешнее API от OpenAI или Cohere начнет тупить, ловить таймауты или лимиты (Rate Limits). Тебе на клиенте придется уменьшить размер пачек (batch size) либо крутить таймауты на прокси (в коде выше стоит `timeout=15.0`, но на тяжелых батчах может потребоваться больше).
- **Разница в сигнатуре ответа `/embed`**: TEI ведет себя по-разному в зависимости от того, прислал ты строку или массив строк. Если засунуть это в стандартные схемы сериализации без ручной проверки типа (как сделано через `isinstance(inputs, str)`), то легаси-клиент просто упадет с ошибкой парсинга JSON, потому что ожидал плоский массив, а получил вложенный.
- **Передача токенов**: Наш код умеет выцеплять токен из стандартного заголовка `Authorization: Bearer <key>`, который присылает твой клиент, и прокидывать его дальше. Но если твой легаси-клиент не умеет настраивать кастомные токены для TEI (так как локальный TEI часто крутится вообще без авторизации), тебе придется жестко зашить ключи в переменные окружения на самом прокси.
