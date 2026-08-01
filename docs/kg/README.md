# Public-safe architecture notes

The original working knowledge graph was removed because it mixed reusable
product specifications with one person's private health and training context.
Personal context is application data, not source code or documentation.

Keel now follows these boundaries:

- Personal records live in the encrypted, local IndexedDB vault.
- The program generator receives a profile assembled from that vault at runtime.
- Source-controlled examples are synthetic and do not describe a real person.
- Missing local context uses neutral defaults rather than a developer's profile.
- Network access remains allowlisted and personal vault records are not sent to
  an application backend.

Reusable implementation details belong beside the code they describe. Product
decisions that need longer documentation should use generic examples and must
pass the repository's public-data audit.
