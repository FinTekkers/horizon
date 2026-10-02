# server/test/fixtures/

## openapi-3.1-schema.json

The official OpenAPI 3.1 meta-schema, byte-for-byte as published at

    https://spec.openapis.org/oas/3.1/schema/2022-10-07

(the `$id` inside the file is that same URL, so provenance is checkable with
`curl <url> | diff - openapi-3.1-schema.json`).

`openapi-spec-valid.test.mjs` validates the document served by
`GET /api/openapi.json` against it. It is vendored rather than fetched because a
test that reaches the network fails on an offline host and passes vacuously if
the fetch is ever made best-effort.

This is a third-party specification document, not a generated artifact. HZ-178's
success metric forbids checking in the Horizon spec itself — that is built from
the routes at server start and only ever served, never written to disk.

### One substitution the test makes

The schema describes a Schema Object as `{"$dynamicRef": "#meta"}`. ajv 8
mis-resolves that reference and ends up applying the Parameter Object schema to
every `parameters[].schema` value, which fails a document that is in fact valid.
The test rewrites those references to `{"$ref": "#/$defs/schema"}`, the same
subschema the `#meta` dynamic anchor names. That subschema is
`{"type": ["object", "boolean"]}` — this is the "without schema validation"
variant of the meta-schema, which deliberately does not recurse into Schema
Objects, so the substitution removes nothing the document would otherwise check.

## caretaker/

Excerpts of HZ-270's own planning artifacts, copied from its step runs:
`hz270-options.md` is the "Plan options & trade-offs" artifact and
`hz270-pm-summary.md` the PM's summary. `caretaker-rules.test.mjs` runs the
caretaker policy over them. The options artifact is kept because it says
"Blocking finding" in prose with no `## Blockers` section, which must not send
it back.
