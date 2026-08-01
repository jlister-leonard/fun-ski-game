# Local program personalization

The planner builds a program from the encrypted runtime athlete profile. Trainer
days are observed rather than programmed. App-session roles are mapped onto the
remaining locally configured days, and the trainer's upper credible volume bound
is subtracted before app volume is allocated.

When no trainer report exists, Keel derives a coarse prior from the locally stored
trainer-focus answer. That text is interpreted on-device and is never bundled or
transmitted. A neutral whole-body prior is used when the local answer is empty.

Existing encrypted schedules, reports, equipment profiles, goals, and program
records remain authoritative across application updates.
