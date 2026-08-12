
## Review fixes
- Pending DTO now explicitly preserves nullable SQL `limits`; pending worker rendering keeps administrator-entered approval fields safe when limits are null.
- Mac join payload now allowlists identity fields and strips caller-supplied limits.
- Focused verification: 9 pass, 0 fail, 22 expect() calls; contracts, control-plane, orchestrator, and web typechecks all exited 0.
