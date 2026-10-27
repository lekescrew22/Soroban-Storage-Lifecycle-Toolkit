## Summary

<!-- What changed and why? -->

## Verification

- [ ] `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration` (when the change affects live RPC behavior)

## Safety and compatibility

- [ ] Reports and documentation do not imply that contract IDs reveal every storage key.
- [ ] No transaction is signed or submitted by this change.
- [ ] RPC credentials and private keys are not logged or committed.
- [ ] Any estimate or assumption is explicitly described.

## Related issue

<!-- Link the issue this PR addresses, if applicable. -->
