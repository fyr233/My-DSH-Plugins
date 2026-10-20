# Verification

Installed on DeepSeek Harness Desktop 0.2.1-rc.2. Installation returned application: applied without warnings.

- Host and Client JavaScript syntax checks passed.
- Initial runtime verification: three core tests passed (null vs blank, exact sections and literal interpolation, collision rollback and disposal).
- Pre-commit cleanup adds regression coverage for prototype-property rejection and the 32,000-character boundary. All five core tests and the three runtime JavaScript syntax checks passed. These are offline tests; the cleanup has not been reloaded into the running Desktop.
- Live tool tested identity and suffix overrides and inspected actual assembled sections (24 sections retained).
- Live prefix setting accepted for four top-level Agents without conflicts.
- Saved marker located in profile cordis.patch.yml.
- Disabled and enabled bundle: saved suffix marker retained and reapplied in actual assembly.
- Reset: three null values persisted to profile; registrations removed, original identity/prefix/suffix restored.
- Live GUI shows localized Settings section and controls without the earlier missing remote.settings injection error.
- No additional inner scroll container (user requested outer scrolling only).

Limits: did not restart the entire Desktop process; persistence tested by disk read and bundle unload/reload instead. GUI save/reset button clicks, dark theme and English visual inspection not completed. Same Host settings.update operation is shared by tool and UI.

Repository-wide validator still reports two development-environment limitations: its engine-range regex does not accept the valid prerelease minimum >=0.2.1-rc.2, and standalone Node cannot resolve the schema dependency of a linked plugin (Desktop resolves its bundled schemastery). Catalog tables regenerated; these errors are not claimed to pass. Runtime installation and native Config projection succeeded.
