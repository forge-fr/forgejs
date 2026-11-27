## Summary

<!-- Describe what this PR changes and why. -->

## Related Issue

<!-- e.g. Fixes #123 -->

## Type of Change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation / examples / benchmarks update

## Verification Checklist

- [ ] `npm run build` compiles all 20 packages cleanly
- [ ] `npm run typecheck` passes with zero TypeScript errors
- [ ] `npm run packages:verify` passes tarball & clean consumer checks
- [ ] `npm run docs:verify` passes documentation example execution (if docs changed)
- [ ] Security & input validation boundaries remain intact (no leaked secrets or weakened defaults)
