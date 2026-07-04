import * as os from 'os';

export function getCpuCount(): number {
  return os.cpus().length;
}

export function getRenderConcurrency(): number {
  return Number(process.env.RENDER_CONCURRENCY) || getCpuCount();
}
