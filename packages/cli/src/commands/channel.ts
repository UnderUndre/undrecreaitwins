export async function channelCommand(
  ctx: { apiUrl: string; tenantId: string; output: string },
  args: string[],
): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      const res = await fetch(`${ctx.apiUrl}/v1/channels`, {
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      const data = (await res.json()) as { data: Record<string, unknown>[] };
      if (ctx.output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.table(
          data.data.map((c: Record<string, unknown>) => ({
            id: c.id,
            type: c.channel_type,
            status: c.status,
            persona_id: c.persona_id,
          })),
        );
      }
      break;
    }
    case 'create': {
      const personaId = args[1];
      const channelType = args[2];
      if (!personaId || !channelType) {
        console.error('Usage: twin channel create <persona_id> <telegram|whatsapp_evolution>');
        process.exit(1);
      }
      const configJson = args[3] ?? '{}';
      const res = await fetch(`${ctx.apiUrl}/v1/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({
          persona_id: personaId,
          channel_type: channelType,
          config: JSON.parse(configJson),
        }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) {
        console.error('Usage: twin channel delete <id>');
        process.exit(1);
      }
      const res = await fetch(`${ctx.apiUrl}/v1/channels/${id}`, {
        method: 'DELETE',
        headers: { 'X-Tenant-ID': ctx.tenantId },
      });
      console.log(res.status === 204 ? 'Deleted' : `Error: ${res.status}`);
      break;
    }
    case 'start':
    case 'stop':
    case 'restart':
      console.log(`${sub} not yet implemented — use docker restart for adapter containers`);
      break;
    default:
      console.log('Usage: twin channel <list|create|delete|start|stop|restart>');
  }
}
