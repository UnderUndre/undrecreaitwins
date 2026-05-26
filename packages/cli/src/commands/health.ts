export async function healthCommand(ctx: { apiUrl: string }): Promise<void> {
  try {
    const res = await fetch(`${ctx.apiUrl}/v1/health`);
    const data = (await res.json()) as Record<string, unknown>;
    console.log(`Status: ${data.status} | Version: ${data.version ?? 'unknown'}`);
    const checks = data.checks as Record<string, string> | undefined;
    if (checks) {
      for (const [name, status] of Object.entries(checks)) {
        console.log(`  ${name}: ${status}`);
      }
    }
  } catch {
    console.log('Status: unreachable');
  }
}
