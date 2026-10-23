import { hash } from '../src/contracts.ts';
import { POOLING_PHASES, POOLING_QUERIES as Q } from '../src/pooling-evidence.ts';
import type { PoolingRun, Observation } from '../src/pooling-evidence.ts';

// Contract-test fixture only. This helper never claims that a database was queried.
export function poolingFixture(): PoolingRun {
  const runId = '11111111-1111-4111-8111-111111111111', collectedAt = '2026-09-28T12:00:00.000Z';
  return { schemaVersion: 1, scenario: 'pooling-session', runId, profile: 'local-lab', collectedAt,
    expiresAt: '2026-09-28T13:00:00.000Z', postgresVersion: '16.10', pgbouncerVersion: '1.22.0', clusterFingerprint: hash('synthetic-test-cluster'),
    poolMode: 'transaction', maxPreparedStatements: 10, cleanup: 'COMPLETE', classification: 'REPRODUCED_BEHAVIOR', cause: null, customerResolution: null, reviewStatus: 'NOT_REVIEWED',
    observations: POOLING_PHASES.map(phase => {
      const endpoint = phase.startsWith('pooled') || phase.startsWith('protocol') ? 'transaction' : 'direct';
      const sqlstate = ['pooled-next','direct-reset'].includes(phase) ? '26000' : phase === 'timeout-control' ? '57014' : null;
      return { phase, endpoint, backend: endpoint === 'direct' ? 100 : phase.endsWith('next') ? 102 : 101,
        heldBackend: ['pooled-next','protocol-next'].includes(phase) ? 101 : null,
        database: 'pslab_pooling', role: 'pslab_app', runId, collectedAt,
        queryHash: hash(phase.startsWith('protocol') ? Q.protocol : phase === 'timeout-control' ? Q.timeout : Q.execute), sqlstate, count: sqlstate ? null : 1 } as Observation;
    }) };
}
