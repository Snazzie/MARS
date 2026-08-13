
## Focus lifecycle review fix
- Merged Escape listener into the open lifecycle effect: captures prior focus, focuses dialog, removes listener, and restores focus on cleanup.
- DOM smoke now rerenders closed and asserts prior trigger focus restoration.
- Verification: 17 tests / 63 assertions pass; web typecheck passes.
