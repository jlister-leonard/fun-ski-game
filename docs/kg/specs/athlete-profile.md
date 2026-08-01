# Runtime athlete profile

An athlete profile is private application data. It is assembled in memory from
the encrypted local vault and passed to pure planning functions. No real profile
belongs in source control, documentation, test fixtures, telemetry, or build
output.

The runtime profile may include training age, locally configured trainer and app
days, equipment, active goals, progression ladders, and discomfort flags.
Missing values use neutral defaults. Source-controlled examples must be clearly
synthetic and must pass `npm run audit:public-data`.
