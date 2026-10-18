# Isolated staging load acceptance

Never point this workload at real child records or production notification providers. Install k6 and prepare at least five active staging readers, valid test NFC cards/enrollments and approved test rules/calendar. Disable real external parent sending in the isolated environment.

Inject API_ORIGIN, SCHOOL_ID, USER_ACCESS_TOKEN and K6_DEVICE_SECRETS_JSON from the staging secret store. The latter is an array of at least five `{code,secret,card_uids:[uppercase hex],boot_id:optional UUID}` objects. Do not put credentials in source, command arguments, screenshots or result uploads. Run `k6 run tests/load/morning-peak.js`. Five readers upload up to 20 fresh tap events per batch while 100 users read dashboards. The script fails clearly without credentials; it has no production mock path.

HTTP thresholds are end-to-end and therefore stricter than a server-only latency target. Capture API timing, commit-to-provider delay, pool use, lock waits, outbox age and hardware queue capacity separately. Run a 5,000-event offline backlog, parallel-school isolation traffic, invalid-card/rate-limit cases, provider outages and a multi-hour soak in addition to this smoke workload. Archive measurements and EXPLAIN plans before approving PERF-REQ targets.
