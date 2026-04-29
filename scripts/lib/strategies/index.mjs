/**
 * Strategy registry.
 *
 * A strategy decides *which ticket runs next*.  All strategies share the same
 * snapshot, agent invocation, logging, and commit pipeline; they differ in
 * traversal order:
 *
 *   batch  — drain the snapshot stage-by-stage in topo/sequence order
 *            (one stage transition per ticket per run; original behavior).
 *   chase  — TBD: serial mode that follows a single ticket through the
 *            pipeline before moving to the next.
 */

import * as batch from './batch.mjs';

export const strategies = { batch };
