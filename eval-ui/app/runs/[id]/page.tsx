import Link from 'next/link';
import { getEvalRun } from '../../../lib/evals-api';

type PageProps = {
  params: {
    id: string;
  };
};

function formatDate(value: string | null): string {
  if (!value) {
    return 'Running';
  }
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default async function RunDetailPage({ params }: PageProps) {
  const run = await getEvalRun(params.id);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-3">
        <Link className="text-sm text-slate-600 underline-offset-2 hover:underline" href="/">
          Back to runs
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-slate-950">Run {run.id}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {formatDate(run.started_at)} · {run.passed_cases}/{run.total_cases} passed
            </p>
          </div>
          <span className={run.passed_cases === run.total_cases ? 'text-sm font-medium text-emerald-700' : 'text-sm font-medium text-rose-700'}>
            {run.passed_cases === run.total_cases ? 'Passed' : 'Failed'}
          </span>
        </div>
      </header>

      <section className="flex flex-col gap-4">
        {run.results.map((result: any) => (
          <article key={result.id} className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-950">{result.case_name}</h2>
              <span className={result.passed ? 'text-sm font-medium text-emerald-700' : 'text-sm font-medium text-rose-700'}>
                {result.passed ? 'Passed' : 'Failed'}
              </span>
            </div>

            <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-4 text-sm leading-6 text-slate-100">
              {result.response || '(no response)'}
            </pre>

            <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
              <table className="w-full table-fixed text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="w-36 px-3 py-2 font-medium">Assertion</th>
                    <th className="w-24 px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.assertion_results.map((assertion: any, index: number) => (
                    <tr key={`${result.id}-${assertion.type}-${index}`}>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700">{assertion.type}</td>
                      <td className={assertion.passed ? 'px-3 py-2 text-emerald-700' : 'px-3 py-2 text-rose-700'}>
                        {assertion.passed ? 'Pass' : 'Fail'}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {assertion.message}
                        {typeof assertion.score === 'number' && typeof assertion.threshold === 'number' && (
                          <span className="ml-2 text-slate-500">
                            {assertion.score.toFixed(3)} / {assertion.threshold}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}