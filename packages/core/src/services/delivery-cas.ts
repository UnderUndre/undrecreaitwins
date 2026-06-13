import { eq, and, ne } from 'drizzle-orm';
import { withTenantContext } from '../db.js';
import { deliveryRecords } from '../models/delivery-record.js';

export async function tryCasFinalDelivery(
  tenantId: string,
  conversationId: string,
  channelMessageId: string,
): Promise<boolean> {
  const result = await withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .update(deliveryRecords)
      .set({ state: 'final_delivered', updatedAt: new Date() })
      .where(
        and(
          eq(deliveryRecords.tenantId, tenantId),
          eq(deliveryRecords.conversationId, conversationId),
          eq(deliveryRecords.channelMessageId, channelMessageId),
          ne(deliveryRecords.state, 'final_delivered'),
        ),
      )
      .returning({ id: deliveryRecords.id });
    return rows.length > 0;
  });
  return result;
}
