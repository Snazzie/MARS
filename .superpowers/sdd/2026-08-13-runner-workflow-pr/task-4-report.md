
## Review fixes
- File-load retry now refetches the files query; preview errors refetch preview.
- Successful creation disables submit and prevents duplicate PR calls.
- Dialog receives focus on open and restores prior focus on close.
- Verification after fixes: focused route tests 12 pass / 50 assertions; web typecheck passes.
- Modal-specific tests remain unavailable because the repository does not contain the requested modal test file; browser smoke remains unavailable in this worker context.
