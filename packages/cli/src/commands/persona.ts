export async function personaCommand(
  ctx: { apiUrl: string; tenantId: string; output: string },
  args: string[],
): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      const res = await fetch(`${ctx.apiUrl}/v1/personas`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = (await res.json()) as { data: Record<string, unknown>[] };
      if (ctx.output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.table(
          data.data.map((p: Record<string, unknown>) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            version: p.version,
          })),
        );
      }
      break;
    }
    case 'create': {
      const name = args[1];
      const slug = args[2];
      const systemPrompt = args[3] ?? 'You are a helpful assistant.';
      if (!name || !slug) {
        console.error('Usage: twin persona create <name> <slug> [system_prompt]');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/personas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({ name, slug, system_prompt: systemPrompt }),
      });
      const data = await res.json();
      console.log(res.status === 201 ? 'Created:' : 'Error:', JSON.stringify(data, null, 2));
      break;
    }
    case 'get': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin persona get <id>');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/personas/${id}`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    case 'update': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin persona update <id> <field> <value>');
        process.exit(1);
      }
      const field = args[2];
      const value = args[3];
      if (!field || !value) {
        console.error('Specify field and value');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/personas/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({ [field]: value }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin persona delete <id>');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/personas/${id}`, {
        method: 'DELETE',
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      console.log(res.status === 204 ? 'Deleted' : `Error: ${res.status}`);
      break;
    }
    default:
      console.log('Usage: twin persona <list|create|get|update|delete>');
  }
}
