// The shape of every job published to the queue
export interface DeliveryJob {
  delivery_id: string;
  event_id: string;
  endpoint_id: string;
  tenant_id: string;
}

// Handler receives a job; throw to nack, return to ack
export type JobHandler = (job: DeliveryJob) => Promise<void>;

export interface Queue {
  publish(job: DeliveryJob): Promise<void>;
  startConsuming(handler: JobHandler): Promise<void>;
  stop(): Promise<void>;
}
