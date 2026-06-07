const BASE_URL =
  process.env.EVAL_ENGINE_URL ?? "http://localhost:8090";

const TOKEN = process.env.EVAL_ENGINE_TOKEN ?? "";
const TENANT_ID = process.env.EVAL_TENANT_ID ?? "";

async function apiFetch(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Tenant-ID": TENANT_ID,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export async function getEvalRuns() {
  return apiFetch("/v1/evals/runs");
}

export async function getEvalRun(id: string) {
  return apiFetch(`/v1/evals/runs/${id}`);
}