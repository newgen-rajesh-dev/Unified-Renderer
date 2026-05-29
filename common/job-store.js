import { Database } from 'bun:sqlite';

const PUBLIC_JOB_FIELDS = [
  'jobId',
  'status',
  'compositionId',
  'createdAt',
  'startedAt',
  'completedAt',
  'failedAt',
  'compositionDir',
  'artifactsDir',
  'compositionPath',
  'outputPath',
  'plannedOutputPath',
  'reservedOutputFileName',
  'uploadedUrl',
  'uploadedKey',
  'mainArtifactPath',
  'finalArtifactPath',
  'intro',
  'outro',
  'bgMusic',
  'width',
  'height',
  'error',
  'statusUrl',
];

export function createJobStore(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      composition_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `);

  const upsert = db.prepare(`
    INSERT INTO jobs (job_id, status, composition_id, created_at, updated_at, data)
    VALUES ($jobId, $status, $compositionId, $createdAt, $updatedAt, $data)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      composition_id = excluded.composition_id,
      updated_at = excluded.updated_at,
      data = excluded.data
  `);
  const get = db.prepare('SELECT data FROM jobs WHERE job_id = ?');
  const list = db.prepare('SELECT data FROM jobs ORDER BY created_at DESC');
  const activeCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM jobs
    WHERE status IN ('preparing_assets', 'rendering', 'stitching', 'applying_bg_music', 'uploading')
  `);
  const totalCount = db.prepare('SELECT COUNT(*) AS count FROM jobs');

  function serialize(job) {
    const data = {};
    for (const field of PUBLIC_JOB_FIELDS) data[field] = job[field] ?? null;
    return data;
  }

  function save(job) {
    const data = serialize(job);
    upsert.run({
      $jobId: job.jobId,
      $status: job.status,
      $compositionId: job.compositionId,
      $createdAt: job.createdAt,
      $updatedAt: new Date().toISOString(),
      $data: JSON.stringify(data),
    });
  }

  function getJob(jobId) {
    const row = get.get(jobId);
    return row ? JSON.parse(row.data) : null;
  }

  function listJobs() {
    return list.all().map(row => JSON.parse(row.data));
  }

  function stats() {
    return {
      activeJobs: activeCount.get().count,
      totalJobs: totalCount.get().count,
    };
  }

  return { save, getJob, listJobs, stats };
}
