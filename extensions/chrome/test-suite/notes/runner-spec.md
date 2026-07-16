# Recipe runner spec

Future Node/Pi runner should:

1. Read `manifest.json`.
2. Probe environment capabilities (`trusted`, `clipboard`, `touch`, `dialogs`, `downloads`, `fileSystem`, `strictCspFallback`).
3. For each entry:
   - read `gate` (`core`, `conditional`, `quality`) and score in that bucket
   - skip if `requires` is unsatisfied and expected is `CONDITIONAL`
   - navigate to challenge URL
   - execute `recipe` in order
   - wait `verdictDelayMs || 500`
   - use `chrome_evaluate` for `JSON.stringify({v:window.__verdict,r:window.__reason,d:window.Challenge?.state?.details,e:window.__events?.slice(-20)})`; CDP evaluation works on strict-CSP pages
   - compare to `expected[mode]`
4. Output:
   - Markdown summary
   - JSON details
   - JUnit XML for CI

Runner must adapt recipe intent:

- expand `${REPO_ROOT}` path placeholders
- adapt unsupported shadow/iframe selector notation to tagged snapshot uid targets or evaluation
- preserve hook install ordering for console/network capture tests
- substitute dynamic tab ids from `chrome_tab_list`
- substitute `$ACTION_REF(role,name)` from the latest `chrome_snapshot` Action Graph and preserve the returned ref exactly
- use screenshot/coordinate input when DOM semantics are insufficient; CSP does not block CDP snapshot/evaluation
- record whether trusted/CDP path was used

Long-horizon task runner should read `task-manifest.json`, replace `$RUN_ID`, solve task, then evaluate task grader expression.
