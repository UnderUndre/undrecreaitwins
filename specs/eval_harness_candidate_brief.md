# Take-Home: Prompt Eval / Regression Harness for the Twin Engine

> **Role:** Full-stack engineer
> **Expected effort:** ~1–2 focused days. We value a **small, working, well-tested, well-reasoned** slice far more than a large half-finished one. Do **not** gold-plate.
> **AI coding assistants are allowed and encouraged.** Tell us how you used them.

---

## 1. Context

We build an AI "digital twin" platform. The **engine** (this repo, `undrecreaitwins`) is the headless runtime that generates assistant replies. Today there is **no way to systematically check whether a persona still answers the way we expect** after a prompt or model change — every check is manual.

Your task: build a small **Prompt Eval / Regression Harness** into this engine — a way to define test cases, run them against a persona through the real chat path, assert on the replies, store the results, and view them.

This is a real (but peripheral) feature. There is **no existing eval tooling** in the repo — you are starting clean.

**How we work — spec-first.** On this team we write a short technical spec (ТЗ) *before* code, review it together, then implement. We want to see that habit. Treat this brief as a loose spec to sharpen: before (or alongside) the code, write a short `SPEC.md` — **half a page, not a thesis** — stating *what* you'll build, your acceptance criteria, and any ambiguities in this brief you had to resolve. Use your own format or a SpecKit-style layout; **don't install any of our tooling for this — the artifact matters, not the ceremony.** Save the *deep* justification of your design decisions for `EVAL_HARNESS.md` (see §3 and §7); `SPEC.md` is the lean up-front plan.

*House saying: «Какое ТЗ — такое и ХЗ» (garbage spec in, garbage out). That's exactly why we want the spec sharpened first.*

---

## 2. What to build (thin vertical slice)

**MUST**

1. **Define eval cases.** A case = input message(s) + a target persona (by `slug`) + one or more **assertions** about the expected reply.
2. **A runner** that executes a case (or a set of cases) against the existing chat path (`ChatService` / the `/v1/chat` flow) and records the outcome.
3. **Assertions that respect LLM non-determinism.** Replies are *stochastic* — exact-string matching is wrong. Support at least:
   - **property/structural** checks (e.g. contains / not-contains / regex / JSON-shape / length bounds), and
   - **at least one "semantic" check** (e.g. an LLM-as-judge assertion, or an embedding/similarity check) — to show you understand what you can and can't assert on an LLM.
4. **Persist** runs and per-case results so they can be queried later.
5. **Expose results over HTTP:** at minimum `GET /v1/evals/runs` and `GET /v1/evals/runs/:id` (JSON). Triggering a run may be an endpoint *or* a script — your call.
6. **A results UI** (see §5 for the required stack): one page that lists runs and lets you drill into a single run's per-case pass/fail. It does **not** need to be pretty — it needs to work and to be **portable into our product web app with minimal changes**.
7. **Tests** following the repo's existing pattern (Vitest; see `packages/api/tests/integration/chat-completions.test.ts` as the model — `vi.mock` + `buildServer()` + `server.inject()`). For the harness's own tests, a **fake/stub LLM provider is the correct choice** (deterministic, no real tokens).

**STRETCH (only if the MUST slice is solid and tested)**

- A second semantic assertion strategy, or a small assertion DSL.
- Regression diffing (compare a run against a previous baseline).
- Per-assertion granularity / flakiness handling (re-run N times, pass if ≥k).

**NON-GOALS**

- **No streaming.** Our twins reply non-streaming; ignore the streaming path entirely.
- No auth/billing/multi-tenant admin work beyond what's needed to make a run execute.
- No big config framework. Keep it lean.

---

## 3. Design decisions we want YOU to make (and justify in your README)

This is the core of what we're evaluating. There is no single right answer — we want your reasoning:

1. **How do you assert reliably on stochastic LLM output?** What are the failure modes of your approach (false pass / false fail), and how do you mitigate them?
2. **`ChatService.complete()` persists to the database on every call** (it inserts a conversation, messages, and a usage event) and has **no dry-run / no-persist mode.** How do you keep eval runs from polluting real conversation/usage data? (There are several valid approaches — pick one and defend it.)
3. **In-process vs HTTP:** do you call `ChatService` directly, or drive it through the HTTP layer? Trade-offs?
4. **Where do eval cases live** — a Drizzle table, or version-controlled fixture files (YAML/JSON), or both? Why?

---

## 4. Conventions to follow (this is a real codebase)

- **Monorepo:** pnpm workspaces, Node ≥ 20, TypeScript strict, ESM (`NodeNext`).
- **Data:** Drizzle ORM. New table → `packages/core/src/models/<name>.ts` → re-export in `models/index.ts` → add relations → `drizzle-kit generate`.
- **Tenancy:** queries run inside `withTenantContext(tenantId, fn)` (sets `app.current_tenant`; Postgres RLS enforces isolation). Personas are unique per `(tenantId, slug)`.
- **Routes:** a route is a `FastifyPluginAsync` with **inline Zod** body validation; mirror `packages/api/src/routes/personas.ts`.
- **Errors:** throw the typed `AppError` subclasses from `packages/shared/src/errors.ts` (`ValidationError`, `NotFoundError`, …). Don't throw bare `Error`.
- **Logging:** Pino (Fastify's logger). No `console.log`.
- **TS hygiene:** no `as any`, no swallowed `catch`.

*The house rule behind all of the above: «Всегда пиши код так, будто сопровождать его будет психопат, который знает, где ты живёшь» — write it for the maintainer who knows where you live.*

---

## 5. UI stack (so the page is portable into our product)

You do **not** get access to our product repo. Build the results page **in the same stack** so we can drop it in later with minimal effort:

- **Next.js 13 + React 18 + Tailwind CSS.**
- Talk to the engine the way our client does: HTTP `fetch` with headers `Authorization: Bearer <token>` and `X-Tenant-ID: <tenantId>`. Keep the data-fetching in a thin, isolated module (so swapping it for our internal client later is trivial).
- Ship it as a **self-contained page + its fetch layer** (a minimal Next app to host/run it for your demo is fine).

---

## 6. Setup & known rough edges (so you don't waste time on archaeology)

This is a young repo. Standing it up is part of the task (you're full-stack — infra is fair game, use AI help if you like), but here's the map so you spend time on the *feature*, not on undocumented potholes:

**External services you'll need**
- **PostgreSQL** — connection via `DATABASE_URL`.
- **Redis** — used by other packages; you may not need it for the harness, but the engine expects it.
- **An OpenAI-compatible LLM endpoint** — `LLM_PROVIDER_URL` (default `http://localhost:4000`), `LLM_DEFAULT_MODEL` (default `gpt-4o`), `LLM_API_KEY`. You can point this at a **local model** (Ollama / LM Studio / LiteLLM) or any cloud key — your choice. For your **demo**, a real-ish model is nice; for **automated tests**, use a fake provider (no tokens).

**Env vars (names only — provide your own values):** `DATABASE_URL`, `LLM_PROVIDER_URL`, `LLM_DEFAULT_MODEL`, `LLM_API_KEY`, `PORT`, `LOG_LEVEL`, plus the Redis URL var.

**Known gaps — work around them, or fix them and say so in your README (we like initiative):** *Без синей изоленты тут не обойтись — sometimes blue electrical tape is the honest fix; just label it.*
- No `.env.example` — you'll assemble env from the above.
- No `migrate` npm script — use the `drizzle-kit` CLI directly (`generate` / `push`).
- The `test:integration` script references a `vitest.integration.config.ts` that **doesn't exist** — create one, or run tests via the existing unit config.
- **No feature routes are wired into the production boot path.** Confirmed: `buildServer()` in `packages/api/src/server.ts` registers only middleware + `/v1/health`; every feature route (`/v1/chat`, `/v1/personas`, …) is registered **only in the tests** (a manual `server.register(routePlugin)` in the test setup). So a freshly-booted server 404s on everything but health. **Register your `/v1/evals` route inside `buildServer()`** (after the middleware plugins, before the factory returns) so it's reachable when the server runs — mirror the `server.register(...)` call the integration tests use. Heads-up tied to §3.3: if your runner drives the chat path *over HTTP* against a running server, note that `/v1/chat` isn't wired into boot either — so register the routes you need, or run in-process. Spotting that the whole boot path is missing its routes (not just yours) is a **plus**, not a requirement.

---

## 7. Deliverables

1. **A Pull Request** against the `main` branch of **https://github.com/UnderUndre/undrecreaitwins**, containing the feature + tests. You won't have push access — so **fork the repo and open the PR from your fork** (the standard OSS flow). We review the PR diff; we don't merge it.
2. **A short `SPEC.md`** in the PR — the half-page spec from §1: scope, acceptance criteria, and the ambiguities you resolved. This is the ТЗ we'd review with you.
3. **Test output** — paste or screenshot showing your tests passing.
4. **A short `EVAL_HARNESS.md`** covering:
   - How to run it (setup steps + commands).
   - Your **design decisions and trade-offs** — the four questions in §3. (Keep `SPEC.md` lean; the *justification* lives here.)
   - **How you used AI tools.** If you used them, show *how you drove them* — the spec/prompts you fed them, and what you corrected or rejected. If you didn't use AI, just say so — nothing to show.
   - What you'd do with more time; anything you'd change.
   - Any repo issues / bugs you hit.
5. **A plus:** a 2–4 minute screen recording demoing a real eval run end-to-end and the results page.

---

## 8. How we evaluate (high level)

We're looking for: a **working** thin slice; sound judgment on the design decisions above (especially asserting on stochastic output and the persistence problem); clean code that fits the repo's conventions; tests that actually run; and clear communication. We care more about *how you think* than about how much you ship.

Good luck — and tell us where you got stuck. That's useful signal, not a negative.

*«Тяжела и неказиста жизнь простого программиста» — we've all been there.*
