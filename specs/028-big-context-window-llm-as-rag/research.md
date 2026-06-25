Здорово. Задача ясна. Давай разберём твои трубы и настроим нормальный проток данных, чтобы ничего не засорялось на полумиллионных токенах. RAG через векторы выкидываем к чертям, строим чистый full-context пайплайн.

Ниже подробный разбор по каждому твоему вопросу. Без соплей, только голые факты, физика процессов и конкретные архитектурные паттерны.

---

### 1. Как хранят документы PrivateGPT, AnythingLLM, OpenWebUI и Quivr?

Большинство готовых опенсорс-коробок заточены под классический векторный RAG, но у каждого своя специфика хранения исходников.

```
                 [ ПАЙПЛАЙН ХРАНЕНИЯ В ОПЕНСОРСЕ ]
                 
  User Upload ──► [ Storage Backend ] ──► (Raw Files) 
                         │
                         ▼
                  [ Parser Engine ]   ──► (Extracted Plain Text / JSON)
                         │
                         ▼
                  [ Index / Vector DB ] 
```

#### AnythingLLM

* **Что хранит:** И исходные файлы, и извлечённый текст.
* **Где именно:** По умолчанию использует локальный диск.
  * В Docker-контейнере все исходники падают в директорию `/app/server/storage/documents/`.
  * Извлечённый текст хранится в виде структурированных `.json` файлов в подпапке `custom-documents/` внутри той же директории. Там лежит сырой текст, разбитый на мелкие смысловые ноды с метаданными.
  * Метаданные связей документов с воркспейсами лежат в SQLite-базе `anythingllm.db`.
* **S3 или диск:** Локальный диск по умолчанию. В облачных деплоях S3 можно подключить только костылями на уровне монтирования томов ОС (например, через NFS/Fuse-драйверы к NAS).

#### OpenWebUI

* **Что хранит:** Хранит исходные файлы и вытащенный текст.
* **Где именно:**
  * Исходные файлы падают на локальный диск в директорию `DATA_DIR/uploads/` (в докере это обычно `/app/backend/data/uploads`).
  * Извлечённый текст складывается прямо в реляционную базу данных (по умолчанию SQLite `webui.db`, но в продакшене переезжает на PostgreSQL) в таблицу `files` в колонку метаданных/контента `file.data.content`.
  * С 2026 года в OpenWebUI завезли официальный **Full Context Mode**. При его активации система берёт сырой текст из базы и суёт его напрямую в системный промпт модели, минуя ChromaDB/PGVector.
* **S3 или диск:** Локальный диск по умолчанию. Но поддерживает интеграцию с S3-совместимыми хранилищами (MinIO/AWS) через переменные окружения для распределённых инстансов.

#### Quivr

* **Что хранит:** Хранит и исходные файлы, и векторы (текст в чистом виде в БД не задерживается, парсится на лету).
* **Где именно:**
  * Логика завязана на абстрактный класс `StorageBase`. Локальная реализация (`LocalStorage`) складывает файлы в `~/.cache/quivr/files` или по пути переменной `QUIVR_LOCAL_STORAGE`.
  * В облачной/прод-версии используется `Supabase Storage` (S3-совместимый бакет под названием `quivr`).
  * Извлечённый текст нарезается на куски, эмбеддится и сохраняется только в векторную базу (Supabase pgvector). Текст хранится как payload вектора, а не как отдельный плоский текстовый кэш.
* **S3 или диск:** S3-совместимое хранилище (Supabase) является для них целевым стандартом деплоя.

#### PrivateGPT

* **Что хранит:** Не хранит сырые исходные файлы долгосрочно в активной рабочей папке. На входе файл парсится, закидывается в базу данных документов, а оригинал удаляется или остаётся лежать в системной кэш-директории.
* **Где именно:**
  * Всё хранится локально в `PGPT_HOME` (обычно `~/.local/share/private-gpt/` или папка `./local_data`).
  * Извлечённый текст хранится внутри встроенной базы Qdrant (или другой выбранной векторной БД) и в файлах метаданных каталога (`docstore.json` и `index_store.json` в старых версиях, либо во внутренней локальной SQLite-базе в новых).
* **S3 или диск:** Исключительно локальный диск.

---

### 2. Сравнение Node.js библиотек для экстракции текста

Если у тебя Node.js/TypeScript на бэкенде, тебе нужно вытаскивать русский текст, таблицы и форматирование без потерь. Давай сравним твоих кандидатов под микроскопом:

| Критерий | `pdf-parse` | `mammoth` | Apache Tika (через API) | `unstructured.io` (JS Client) | **SOTA: Docling** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Стек / Язык** | Pure JS | Pure JS | Java (требует JRE или API) | Python-сервис (требует API) | Python-сервис (или Node wrapper) |
| **Работа с PDF-таблицами** | **Ужасно.** Сливает столбцы в одну нечитаемую кучу. | Не поддерживает PDF (только DOCX). | **Посредственно.** Теряет сетку, выдаёт текст через пробелы. | **Отлично.** Возвращает JSON-структуру ячеек и Markdown. | **Идеально.** Выдаёт чистый Markdown-код таблиц. |
| **DOCX форматирование** | Не поддерживает. | **Отлично.** Переводит стили в семантический HTML (`<h1>`, `<strong>`). | **Хорошо.** Выдаёт XHTML-разметку. | **Отлично.** Парсит на логические элементы. | **Отлично.** Полный маппинг разметки. |
| **Кириллица** | Относительно нормально, если в PDF есть UTF-карты. Иначе — кракозябры. | Отлично (OpenXML парсится без проблем). | Отлично. Огромная база встроенных кодировок. | Отлично, но зависит от качества OCR-движка (Tesseract). | Отлично, использует современные OCR и Layout-модели. |
| **Ресурсоёмкость** | Минимальная, выполняется прямо в ивент-лупе Node.js. | Минимальная. | Высокая. Жрёт память, требует JVM в фоне. | Огромная (требует тяжелых ML-моделей разметки). | Средняя/Высокая. |

#### Вердикт Валера-инжиниринга

1. **`pdf-parse`** — это дешёвый пластиковый сифон. Для простых текстовых PDF пойдёт, но как только прилетит документ с таблицами на русском — он всё размажет в нечитаемую кашу. Потеряешь смысл данных.
2. **`mammoth`** — идеальный кран, но только для одной трубы (DOCX). Его нужно держать в системе строго как специализированный процессор для вордовских файлов. Он преобразует DOCX в семантический HTML, который идеально скармливать LLM.
3. **Apache Tika** — старый чугунный смеситель. Слишком тяжёлый для современной Node.js-инфраструктуры, требует Java-процесс рядом. Таблицы парсит криво.
4. **`unstructured.io`** — дорогой импортный сантехнический пульт. Из TypeScript ты будешь дёргать их облачную ручку (`unstructured-js-client`) или разворачивать их монструозный Docker-контейнер локально. Парсит таблицы идеально, выдаёт чистый JSON. Если есть бюджет на API — юзай его.
5. **Внезапный SOTA-кандидат: Docling (от IBM)**. Сейчас все нормальные парни переходят на него. Он умеет выдавать документ сразу в чистом Markdown, где таблицы свёрстаны в MD-формате. LLM от этого Markdown буквально кайфуют.

**Рекомендуемая Node.js-схема парсинга:**

```typescript
import { promises as fs } from 'fs';
import mammoth from 'mammoth';
import { UnstructuredClient } from 'unstructured-client';

async function extractText(filePath: string, fileType: string): Promise<string> {
  const fileBuffer = await fs.readFile(filePath);
  
  if (fileType === 'docx') {
    // Mammoth идеален для DOCX, переводим в HTML/Text
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  }
  
  if (fileType === 'pdf') {
    // Для сложных PDF с таблицами стучимся в Unstructured (локальный или облачный инстанс)
    const client = new UnstructuredClient({ apiKey: process.env.UNSTRUCTURED_KEY });
    const response = await client.general.partition({
      files: { content: fileBuffer, fileName: filePath },
      strategy: 'hi_res', // Обязательно hi_res для таблиц
    });
    // Собираем текст элементов в одну простыню
    return response.elements.map(el => el.text).join('\n\n');
  }
  
  return fileBuffer.toString('utf-8'); // Обычный TXT
}
```

---

### 3. Паттерн "Текстового кэша" (Document Text Cache)

Парсить файлы через тяжелые библиотеки (особенно PDF с таблицами) — это пиздец как долго и дорого по CPU. Если юзер перезальёт тот же файл или ты будешь дёргать его при каждом запросе, сервер ляжет. Нужен кэш текстового контента на базе контентной адресации (SHA-256).

```
                  [ СХЕМА ТЕКСТОВОГО КЭША (SHA-256) ]
                  
   Upload File ──► [ Считаем SHA-256 хэш контента ]
                                │
                                ▼
                   Есть ли хэш в `document_cache`?
                     /                       \
                  (Да)                      (Нет)
                   /                           \
         [ CACHE HIT ]                     [ CACHE MISS ]
     Достаём `extracted_text`         Запускаем парсер (Unstructured/Mammoth)
     из БД за 5-10 мс.                         │
                                               ▼
                                      Сохраняем сырой текст в `document_cache`
                                      Связываем `user_documents` -> `document_cache`
```

#### SQL-структура таблиц кэширования

```sql
-- Таблица кэша. Хранит извлеченный текст один раз, даже если 100 юзеров загрузили один файл.
CREATE TABLE document_cache (
    file_hash VARCHAR(64) PRIMARY KEY, -- SHA-256 от содержимого файла
    extracted_text TEXT NOT NULL,      -- Текстовая простыня для инжекта в LLM
    char_count INTEGER NOT NULL,       -- Длина для быстрой оценки токенов
    created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица связи конкретных загрузок пользователей с кэшем контента
CREATE TABLE user_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_hash VARCHAR(64) NOT NULL REFERENCES document_cache(file_hash) ON DELETE CASCADE,
    uploaded_at TIMESTAMP DEFAULT NOW(),
    priority INTEGER DEFAULT 1,        -- Важно для алгоритма усечения контекста!
    UNIQUE(user_id, filename)          -- Защита от дублей имен у одного юзера
);
```

#### Реализация на TypeScript (Бизнес-логика)

```typescript
import * as crypto from 'crypto';

interface UploadResult {
  text: string;
  cacheHit: boolean;
}

async function handleDocumentUpload(
  userId: string, 
  filename: string, 
  fileBuffer: Buffer,
  fileType: string
): Promise<UploadResult> {
  // 1. Считаем хэш от байтов файла (уникальный отпечаток контента)
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // 2. Проверяем, парсили ли мы этот контент ранее
  const existingCache = await db.query(
    'SELECT extracted_text FROM document_cache WHERE file_hash = $1', 
    [fileHash]
  );

  let extractedText = '';
  let cacheHit = false;

  if (existingCache.rows.length > 0) {
    // Попали в кэш! Избежали дорогого парсинга
    extractedText = existingCache.rows[0].extracted_text;
    cacheHit = true;
  } else {
    // Мимо кэша. Запускаем тяжелую артиллерию
    extractedText = await parseFileBuffer(fileBuffer, fileType);
    
    // Пишем в кэш
    await db.query(
      `INSERT INTO document_cache (file_hash, extracted_text, char_count) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (file_hash) DO NOTHING`,
      [fileHash, extractedText, extractedText.length]
    );
  }

  // 3. Создаем или обновляем запись пользователя (логика инвалидации при re-upload)
  // ON CONFLICT по (user_id, filename) перезапишет хэш файла на новый, старый кэш удалится по расписанию/триггером
  await db.query(
    `INSERT INTO user_documents (user_id, filename, file_hash) 
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, filename) 
     DO UPDATE SET file_hash = EXCLUDED.file_hash, uploaded_at = NOW()`,
    [userId, filename, fileHash]
  );

  return { text: extractedText, cacheHit };
}
```

---

### 4. Производительность PostgreSQL: TEXT vs pg_largeobject vs TOAST

Давай разберёмся, как СУБД тащит тяжелые текстовые блоки на физическом уровне.

#### Физика процессов в PostgreSQL

PostgreSQL оперирует страницами данных по **8KB**. Строка таблицы не может быть размазана по страницам хаотично. Если твои текстовые данные превышают лимит в **2KB** (`TOAST_TUPLE_THRESHOLD`), СУБД автоматически задействует технологию **TOAST** (The Oversized-Attribute Storage Technique).

1. **TOAST-сжатие:** СУБД сначала пытается сжать твой текст (по умолчанию используется встроенный `pglz`, а в современных версиях 14+ можно включить реактивный `lz4`). Текст размером 500KB обычно сжимается до 150KB.
2. **Аут-оф-лайн хранение (Out-of-line):** Если сжатая строка всё равно не влезает в страницу, Postgres выносит это значение в специальную скрытую таблицу TOAST, а в оригинальной строке оставляет мелкий 18-байтный указатель (pointer). В TOAST-таблице данные бьются на чанки по 2KB.

#### Сравнение решений для хранения 500KB текста

| Характеристика | TEXT Column + TOAST (Extended) | pg_largeobject (LO) |
| :--- | :--- | :--- |
| **Удобство работы** | Прозрачно. Обычный SQL `SELECT text`. | Геморрой. Требует работы через OID-функции (`lo_get`, `lo_open`). |
| **Очистка данных** | Автоматически. Удалил строку — TOAST-данные удалились. | **Ужасно.** При удалении строки объект в `pg_largeobject` остаётся сиротой. Требует утилиты `vacuumlo` или триггеров. |
| **Индексация** | Можно строить индексы (хотя для полнотекстового поиска 500KB лучше юзать вектор/Elastic). | Невозможно индексировать внутренности напрямую. |
| **Производительность** | Высокая при правильном подходе (Проекция колонок). | Средняя. Дополнительные накладные расходы на чтение потока байт. |

#### Ответ на вопрос: Какой перформанс SELECT на 50–200 строках?

Если ты сделаешь `SELECT full_text FROM documents WHERE persona_id = 42` и вернёшь 200 строк по 500KB (в сумме ~100MB сырого текста), ты упрёшься в три бутылочных горлышка:

1. **CPU на декомпрессию TOAST:** Если используется дефолтный `pglz`, распаковка 100MB текста сожрёт процессор на 150-300 мс.
   * **Решение:** Переведи колонку на `lz4` (доступно с PG 14). Он распаковывает данные почти мгновенно, не нагружая CPU.

     ```sql
     ALTER TABLE document_cache ALTER COLUMN extracted_text SET COMPRESSION lz4;
     ```

2. **I/O на сборку чанков:** Чтение TOAST-таблицы — это прыжки по страницам диска. Если данные не лежат в оперативной памяти (`shared_buffers`), диск начнёт захлёбываться от случайного чтения.
3. **Объём трафика:** Гонять 100MB текста по сети между PG и твоим Node.js-сервисом на каждый чих — это архитектурное преступление.

#### Золотые правила проектирования бэкенда с большими текстами

* **Никаких `SELECT *`!** Твои базовые запросы для логики (поиск, фильтрация, вывод списков) должны дёргать только метаданные (название, хэш, размер, дата). Оригинальную колонку `full_text` запрашивай **СТРОГО** в самый последний момент, когда непосредственно формируешь пачку данных для отправки в LLM.
* Держи таблицу документов "узкой".

  ```sql
  -- Быстрый прогон: Postgres даже не касается TOAST-таблицы, запрос выполняется за < 1 мс
  SELECT id, filename, char_count FROM user_documents WHERE user_id = $1;
  
  -- Тяжелый прогон: Достаём текст только для сборки контекста LLM
  SELECT extracted_text FROM document_cache WHERE file_hash = $1;
  ```

---

### 5. Алгоритм "Приоритета документов" для усечения контекста

Когда у тебя 50 документов по 500KB (это ~25 миллионов токенов!), они физически не влезут ни в 128K, ни в 200K контекста. Опенсорсные UI вроде OpenWebUI в таких случаях просто шлют тебя нахер и выдают ошибку провайдера `400 Bad Request / Context Length Exceeded`. Нам нужно написать свой умный распределитель "бюджета токенов" (Token Budgeting Engine).

```
                 [ ПАЙПЛАЙН СБОРКИ КОНТЕКСТА (TOKEN BUDGET) ]
                 
  Raw Docs List ──► [ Считаем предварительные токены ] (1 симв ≈ 0.25 токена)
                           │
                           ▼
                    Сортировка документов по:
                    1. Priority (User pinned) ──► 2. Recency (Свежесть)
                           │
                           ▼
                    [ Запускаем цикл набивки контекста ]
                    Пока (Сумма токенов + История < 120,000) {
                        Добавляем документ целиком;
                    } Иначе {
                        Отрезаем/пропускаем оставшиеся доки;
                    }
                           │
                           ▼
                    [ Итоговый Сформированный Промпт ]
```

#### TypeScript-реализация модуля сборки промпта с жестким лимитом токенов

```typescript
import { getEncoding } from 'js-tiktoken';

interface DocumentWithMeta {
  filename: string;
  text: string;
  priority: number;   // 1 - низкий, 10 - критически важный (например, закреплен юзером)
  uploadedAt: Date;
}

const tokenizer = getEncoding('cl100k_base'); // Стандартный токенайзер для GPT/Claude

function buildTruncatedContext(
  documents: DocumentWithMeta[],
  systemPrompt: string,
  userQuery: string,
  maxContextTokens: number = 120000 // Оставляем буфер из 8000-20000 токенов под генерацию ответа
): string {
  // 1. Считаем базовые затраты токенов на системные инструкции и запрос пользователя
  const systemTokens = tokenizer.encode(systemPrompt).length;
  const queryTokens = tokenizer.encode(userQuery).length;
  
  let remainingBudget = maxContextTokens - systemTokens - queryTokens;
  
  if (remainingBudget <= 0) {
    throw new Error('Критическая системная ошибка: Базовый промпт больше лимита контекста!');
  }

  // 2. Сортируем документы по приоритету (сначала важные), а затем по дате заливки (свежие первее)
  const sortedDocs = [...documents].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority; // Сортировка по убыванию приоритета
    }
    return b.uploadedAt.getTime() - a.uploadedAt.getTime(); // Сортировка по дате (новые выше)
  });

  const selectedDocs: string[] = [];
  let totalInjectedTokens = 0;

  // 3. Набиваем контекст документами, пока влезаем в лимит
  for (const doc of sortedDocs) {
    const docTokens = tokenizer.encode(doc.text).length;

    if (remainingBudget - docTokens >= 0) {
      // Документ влезает целиком
      selectedDocs.push(
        `<document name="${doc.filename}" priority="${doc.priority}">\n${doc.text}\n</document>`
      );
      remainingBudget -= docTokens;
      totalInjectedTokens += docTokens;
    } else {
      // Документ целиком не лезет. 
      // Стратегия: либо дропаем его нахер, либо обрезаем под остаток бюджета
      if (remainingBudget > 5000 && doc.priority >= 5) {
        // Если осталось прилично токенов (>5k) и документ важный, заталкиваем кусок
        const truncatedText = truncateToTokenLimit(doc.text, remainingBudget);
        selectedDocs.push(
          `<document name="${doc.filename}" priority="${doc.priority}" status="truncated_due_to_limit">\n${truncatedText}\n</document>`
        );
        console.warn(`Документ ${doc.filename} усечен под лимит контекста.`);
        break; // Бюджет исчерпан под ноль
      } else {
        console.warn(`Документ ${doc.filename} пропущен из-за превышения лимита токенов.`);
      }
    }
  }

  // 4. Склеиваем финальный пирог
  return `${systemPrompt}\n\nНиже предоставлены документы пользователя:\n${selectedDocs.join('\n\n')}\n\nВопрос: ${userQuery}`;
}

// Вспомогательная функция жесткого усечения строки по токенам
function truncateToTokenLimit(text: string, tokenLimit: number): string {
  const tokens = tokenizer.encode(text);
  const slicedTokens = tokens.slice(0, tokenLimit);
  return tokenizer.decode(slicedTokens);
}
```

---

### Резюме по архитектуре твоих "труб"

Чтобы твоя система летала и не давала течей на больших объемах данных:

1. **Экстракция:** mammoth для DOCX + Docling (или Unstructured API) для PDF таблиц. pdf-parse отправь на свалку истории.
2. **Кэширование:** На входе считай SHA-256 хэш файла. Если хэш совпал — доставай готовый текст из `document_cache` за 5 мс, минуя парсеры.
3. **База данных:** Используй классическую связку таблиц с типом `TEXT` в PostgreSQL. Переведи компрессию на `lz4` для разгрузки процессора при частых распаковках. Никогда не делай `SELECT full_text` без явной необходимости.
4. **Контекст:** Напиши строгий токенайзер на бэкенде. Сортируй документы по приоритету (User pinned / Recency) и собирай итоговый промпт жадным алгоритмом, пока не упрёшься в лимит в 120-150К токенов. Всё, что не влезло — отсекай на уровне бэкенда, не дожидаясь падения LLM-провайдера.
