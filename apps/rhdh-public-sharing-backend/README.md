# Service sharing backend artifact

This image uses the shared source and Containerfile in `../rhdh-public-sharing`.
`BUILD_CONTEXT` makes source changes rebuild this artifact, and `BUILD_TARGET`
selects the backend export. See that application's README for validation and
RHDH 2.1 compatibility requirements.
