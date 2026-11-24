import type { ConsentEvent, FoldedState } from './types.js';

/**
 * The precedence engine (DESIGN.md §6–§7).
 *
 * Current state for an (identity, system) pair is a pure fold over that
 * pair's events ordered by occurred_at (the platform's own timestamp),
 * with event id as the tiebreaker. Late-arriving events therefore change
 * the result deterministically on recompute — never by arrival order.
 *
 * Rules encoded here:
 *  1. A derived OPT-IN never overrides any explicit state. It applies only
 *     when the system is in `unknown` or derived `suppressed`.
 *  2. A derived OPT-OUT suppresses everything *except* an explicit opt-out,
 *     which it leaves untouched (the consumer's own revocation at that
 *     system is the stronger record; the result is "out" either way).
 *     Note the asymmetry with rule 1: derived suppression MAY override an
 *     explicit opt-in — over-suppression is always legally safe.
 *  3. An explicit event always applies at its own system, including an
 *     explicit opt-in over a prior explicit opt-out (consumer renewing
 *     consent in-channel, e.g. STOP then START).
 *  4. Ties at equal provenance resolve toward suppression (handled by
 *     ordering: same-timestamp events apply in insertion order, and a
 *     derived opt-in cannot displace any opt-out regardless).
 */
export function foldState(events: ConsentEvent[]): FoldedState {
  const sorted = [...events].sort(
    (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || a.id - b.id,
  );

  let st: FoldedState = { state: 'unknown', provenance: null, as_of_event: null };

  for (const e of sorted) {
    if (e.provenance === 'explicit') {
      // Rule 3: explicit events always apply at their own system.
      st = {
        state: e.direction === 'opt_in' ? 'opted_in' : 'opted_out',
        provenance: 'explicit',
        as_of_event: e.id,
      };
    } else if (e.direction === 'opt_out') {
      // Rule 2: derived suppression applies unless explicit opt-out already holds.
      if (!(st.state === 'opted_out' && st.provenance === 'explicit')) {
        st = { state: 'suppressed', provenance: 'derived', as_of_event: e.id };
      }
    } else {
      // Rule 1: derived opt-in only over unknown / derived suppression.
      if (
        st.state === 'unknown' ||
        (st.state === 'suppressed' && st.provenance === 'derived')
      ) {
        st = { state: 'opted_in', provenance: 'derived', as_of_event: e.id };
      }
    }
  }
  return st;
}

/** Is the consumer reachable on this system given a folded state? */
export function isReachable(s: FoldedState): boolean {
  return s.state === 'opted_in';
}
