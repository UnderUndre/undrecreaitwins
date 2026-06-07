import Link from 'next/link';
import { getEvalRuns } from '../lib/evals-api';

function formatDate(value: string | null): string {
  if (!value) {
    return 'Running';
  }
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function statusLabel(passed: number, total: number): string {
  return `${passed}/${total}`;
}

export default async function RunsPage() {
  const runs = await getEvalRuns();

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-slate-950">Prompt Eval Runs</h1>
          <p className="mt-1 text-sm text-slate-600">{runs.total} recorded runs</p>
        </div>
      </header>

      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="w-44 px-4 py-3 font-medium">Started</th>
              <th className="w-44 px-4 py-3 font-medium">Finished</th>
              <th className="w-28 px-4 py-3 font-medium">Passed</th>
              <th className="px-4 py-3 font-medium">Run ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.data.map((run: { id: string; started_at: string | null; finished_at: string | null; passed_cases: number; total_cases: number }) => (
              <tr key={run.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-700">{formatDate(run.started_at)}</td>
                <td className="px-4 py-3 text-slate-700">{formatDate(run.finished_at)}</td>
                <td className="px-4 py-3">
                  <span className={run.passed_cases === run.total_cases ? 'text-emerald-700' : 'text-rose-700'}>
                    {statusLabel(run.passed_cases, run.total_cases)}
                  </span>
                </td>
                <td className="truncate px-4 py-3 font-mono text-xs text-slate-700">
                  <Link className="underline-offset-2 hover:underline" href={`/runs/${run.id}`}>
                    {run.id}
                  </Link>
                </td>
              </tr>
            ))}
            {runs.data.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={4}>
                  No runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}