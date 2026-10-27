import type { Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyRetentionWork(transaction: object, kind: AttentionSourceKind) {
  if (kind === "approval") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
}

export function writeApprovalChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyRetentionWork(tx, "approval");
    return write(tx as unknown as Db);
  });
}
