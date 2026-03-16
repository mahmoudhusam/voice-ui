import { processFile } from './whisper.js';
import { broadcastToClient } from '../server.js';

const queue = [];
const jobs = new Map();
let processing = false;

export function addJob(job) {
  job.status = 'queued';
  queue.push(job);
  jobs.set(job.id, job);

  const position = queue.length;
  broadcastToClient(job.clientId, {
    type: 'job_queued',
    jobId: job.id,
    originalName: job.originalName,
    position,
  });

  console.log(`[Queue] Job ${job.id} queued (${job.originalName}), position: ${position}`);
  processNext();
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

async function processNext() {
  if (processing || queue.length === 0) return;

  processing = true;
  const job = queue.shift();
  job.status = 'processing';
  job.startedAt = Date.now();

  console.log(`[Queue] Processing job ${job.id} (${job.originalName})`);

  broadcastToClient(job.clientId, {
    type: 'job_started',
    jobId: job.id,
    originalName: job.originalName,
  });

  try {
    const outputs = await processFile(job, (progressData) => {
      broadcastToClient(job.clientId, {
        type: 'progress',
        jobId: job.id,
        ...progressData,
      });
    });

    job.status = 'completed';
    job.completedAt = Date.now();
    job.duration = job.completedAt - job.startedAt;
    job.outputs = outputs;

    console.log(`[Queue] Job ${job.id} completed (${job.originalName}) in ${job.duration}ms`);

    broadcastToClient(job.clientId, {
      type: 'job_completed',
      jobId: job.id,
      originalName: job.originalName,
      duration: job.duration,
      outputs: outputs.map((o) => ({
        filename: o.filename,
        format: o.format,
        downloadUrl: `/api/jobs/${job.id}/download/${o.filename}`,
      })),
    });
  } catch (err) {
    job.status = 'failed';
    job.completedAt = Date.now();
    job.duration = job.completedAt - job.startedAt;
    job.error = err.message;

    console.error(`[Queue] Job ${job.id} failed (${job.originalName}):`, err.message);

    broadcastToClient(job.clientId, {
      type: 'job_failed',
      jobId: job.id,
      originalName: job.originalName,
      error: err.message,
    });
  }

  processing = false;
  processNext();
}
