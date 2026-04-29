/**
 * Strategy registry.
 *
 * A strategy decides *which ticket runs next*.  All strategies share the same
 * snapshot, agent invocation, logging, and commit pipeline; they differ in
 * traversal order:
 *
 *   batch  — drain the snapshot stage-by-stage in topo/sequence order
 *            (one stage transition per ticket per run; original behavior).
 *   chase  — pick one root ticket and follow it through every stage to
 *            completion before moving to the next root (ticket-major).
 *            Block/backlog landings cascade through the queue via prereq.
 */

import * as batch from './batch.mjs';
import * as chase from './chase.mjs';

export const strategies = { batch, chase };
export const KNOWN_STRATEGIES = Object.keys(strategies);
