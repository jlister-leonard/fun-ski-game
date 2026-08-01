# Private data boundary

Keel's source tree contains reusable product logic and generic reference data.
It must not contain a real person's health profile, medications, goals,
schedule, gym inventory, or coaching handoff.

Personal records belong in the encrypted local IndexedDB vault. The runtime may
derive an in-memory planning profile from that vault, but it must not export the
profile, use it as a source-controlled fixture, or send it to an application
backend. Missing local context uses neutral defaults.

All source-controlled examples must be synthetic. The public-data audit checks
for known private handoff phrases before a change can pass verification.
