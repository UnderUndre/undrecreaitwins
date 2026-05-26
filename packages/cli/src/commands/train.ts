export async function trainCommand(
  ctx: { apiUrl: string; tenantId: string; output: string },
  args: string[],
): Promise<void> {
  const sub = args[0] ?? 'status';

  switch (sub) {
    case 'start': {
      const personaId = args[1];
      const filePath = args[2];
      if (!personaId || !filePath) {
        console.error('Usage: twin train start <persona_id> <file_path> [source_type]');
        process.exit(1);
      }
      const sourceType = args[3];

      const { readFileSync } = await import('fs');
      const { basename } = await import('path');
      const fileBuffer = readFileSync(filePath);
      const fileName = basename(filePath);

      const formData = new FormData();
      const blob = new Blob([fileBuffer]);
      formData.append('file', blob, fileName);
      if (sourceType) formData.append('source_type', sourceType);

      const res = await fetch(`${ctx.apiUrl}/v1/personas/${personaId}/train`, {
        method: 'POST',
        headers: { 'X-Tenant-ID': ctx.tenantId },
        body: formData,
      });
      const data = await res.json();
      console.log(
        res.status === 202
          ? `Training started: ${JSON.stringify(data)}`
          : `Error: ${JSON.stringify(data)}`,
      );
      break;
    }
    case 'status': {
      const jobId = args[1];
      if (!jobId) {
        console.error('Usage: twin train status <job_id>');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/training-jobs/${jobId}`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = (await res.json()) as Record<string, unknown>;
      console.log(`Status: ${data.status} | Progress: ${data.progress_percent}%`);
      if (data.error_message) console.log(`Error: ${data.error_message}`);
      break;
    }
    case 'cancel': {
      console.log('Cancel not yet implemented');
      break;
    }
    default:
      console.log('Usage: twin train <start|status|cancel>');
  }
}
