export async function conversationCommand(
  ctx: { apiUrl: string; tenantId: string; output: string },
  args: string[],
): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      const res = await fetch(`${ctx.apiUrl}/v1/conversations`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = (await res.json()) as { data: Record<string, unknown>[] };
      if (ctx.output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.table(
          data.data.map((c: Record<string, unknown>) => ({
            id: c.id,
            persona_id: c.persona_id,
            message_count: c.message_count,
            started_at: c.started_at,
          })),
        );
      }
      break;
    }
    case 'get': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin conversation get <id>');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/conversations/${id}/messages`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = (await res.json()) as { data: Record<string, unknown>[] };
      if (ctx.output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        for (const msg of data.data) {
          console.log(`[${msg.role}] ${msg.content}`);
        }
      }
      break;
    }
    case 'export': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin conversation export <id>');
        process.exit(1);
      }
      const format = args[2] ?? 'json';
      const res = await fetch(`${ctx.apiUrl}/v1/conversations/${id}/messages`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = await res.json();
      if (format === 'markdown') {
        for (const msg of (data as { data: Record<string, unknown>[] }).data) {
          console.log(`**${msg.role}**: ${msg.content}\n`);
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      break;
    }
    default:
      console.log('Usage: twin conversation <list|get|export>');
  }
}
