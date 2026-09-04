# AGENTS.md

## Testing

- Every behavior-changing feature must include automated tests for its user-visible contract.
- Every bug fix must include a regression test that fails before the fix and passes afterward.
- Choose the smallest reliable test level: unit tests for rules and edge cases, integration tests for component boundaries, and end-to-end tests for critical user journeys or runtime compatibility risks.
- When extending Pi APIs or TUI behavior, test against the real public interface shape rather than permissive mocks that hide compatibility failures.
- Run the relevant focused tests while developing and the repository's full check before delivery. If a test is impractical, state what is untested and why.
- Keep tests deterministic, readable, and focused on behavior rather than implementation details.
