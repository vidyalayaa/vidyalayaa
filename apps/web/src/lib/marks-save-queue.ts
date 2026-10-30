export interface QueuedMark {
  key: string;
  studentId: string;
  subjectId: string;
  score: number;
  remarks: string | null;
  label: string;
  status: 'queued' | 'saving' | 'failed';
  error?: string;
}
export interface MarksQueueSnapshot {
  jobs: QueuedMark[];
  confirmed: number;
}
export class MarksSaveQueue {
  private jobs: QueuedMark[];
  private confirmed = 0;
  private running = false;
  private disposed = false;
  private abort?: AbortController;
  private listeners = new Set<(snapshot: MarksQueueSnapshot) => void>();
  constructor(
    private send: (job: QueuedMark, signal: AbortSignal) => Promise<void>,
    private persist: (snapshot: MarksQueueSnapshot) => void,
    initial: QueuedMark[] = [],
  ) {
    this.jobs = initial.map((job) => ({
      ...job,
      status: 'failed',
      error: 'This save was not confirmed. Retry to resume safely.',
    }));
  }
  snapshot(): MarksQueueSnapshot {
    return { jobs: this.jobs.map((job) => ({ ...job })), confirmed: this.confirmed };
  }
  subscribe(listener: (snapshot: MarksQueueSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    const snapshot = this.snapshot();
    this.persist(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
  enqueue(job: Omit<QueuedMark, 'key' | 'status' | 'error'>) {
    if (this.disposed) throw new Error('Reopen marks entry to continue.');
    this.jobs.push({ ...job, key: crypto.randomUUID(), status: 'queued' });
    this.publish();
    void this.drain();
  }
  retry() {
    if (this.disposed || this.running) return;
    this.jobs = this.jobs.map((job) => ({ ...job, status: 'queued', error: undefined }));
    this.publish();
    void this.drain();
  }
  private async drain() {
    if (this.running || this.disposed || this.jobs.some((job) => job.status === 'failed')) return;
    const job = this.jobs[0];
    if (!job) return;
    this.running = true;
    this.abort = new AbortController();
    job.status = 'saving';
    this.publish();
    try {
      await this.send({ ...job }, this.abort.signal);
      if (this.disposed) return;
      this.jobs = this.jobs.filter((saved) => saved.key !== job.key);
      this.confirmed++;
      this.publish();
    } catch (error) {
      if (!this.disposed) {
        job.status = 'failed';
        job.error = (error as Error).message || 'Save not confirmed. Retry to resume.';
        this.publish();
      }
    } finally {
      this.running = false;
      if (!this.disposed) void this.drain();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    this.jobs = this.jobs.map((job) => ({
      ...job,
      status: 'failed',
      error: 'Save not confirmed before closing. Retry to resume safely.',
    }));
    this.publish();
    this.listeners.clear();
  }
}
