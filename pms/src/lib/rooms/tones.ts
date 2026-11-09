import type { StatusDimension } from '@/types/database';

const TONES: Record<StatusDimension, Record<string, string>> = {
  occupancy: { VACANT: 'tone-green', RESERVED: 'tone-blue', OCCUPIED: 'tone-violet' },
  housekeeping: { CLEAN: 'tone-green', DIRTY: 'tone-amber', IN_PROGRESS: 'tone-blue', INSPECTION_REQUIRED: 'tone-violet' },
  maintenance: { OPERATIONAL: 'tone-slate', OUT_OF_ORDER: 'tone-rose' }
};

export function toneFor(dimension: StatusDimension, value: string): string {
  return TONES[dimension][value] ?? 'tone-slate';
}
