---
applyTo: ".github/workflows/**"
---
# Mandatory GitHub Actions policy - MANUAL ONLY

- All GitHub Actions workflows must be triggered exclusively using `workflow_dispatch`.
- Never add automatic triggers: `push`, `pull_request`, `pull_request_target`, `schedule`, `workflow_run`, `release`, `create`, `delete`, `repository_dispatch`, `issue_comment`, or other automated events.
- Do not re-enable workflows automatically as part of CI, CD, releases, PR reviews, bot tasks, or automated maintenance.
- Preserve manual workflows and their jobs; users can explicitly run them with GitHub Actions > Run workflow.
- Before committing any changes under `.github/workflows/`, verify every workflow's `on` key contains only `workflow_dispatch` (optional manual inputs are permitted).
- Reason: prevent unwanted GitHub Actions minutes and charges.
- This policy applies to all branches and contributors; if a branch has an older workflow definition, update it before merging.
