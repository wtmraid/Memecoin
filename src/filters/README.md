# filters/ — Phase 2 (not built yet)
One pure function per safety check: `(facts, thresholds) → { pass, reason, value }`.
Ordered cheap → expensive; the Jupiter sell simulation (1 rps on the free plan) runs last.
All thresholds come from `config/*.json`. Every filter gets its own unit tests.
