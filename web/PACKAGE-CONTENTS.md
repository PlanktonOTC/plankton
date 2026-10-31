# PLANKTON portable website

The package includes editable React/CSS source, web media and fonts, the compiled dist preview, the dependency lockfile, tests, backend handoff and selected review evidence. Read START-HERE.md first.

## Package boundaries

- This is a local interactive demonstration, not connected financial infrastructure.
- The four owner-supplied product PDFs are included in docs/source-documents for backend development, outside public and dist. Prior brand experiments, private generation prompts, conversation history, dependency folders and raw video masters are excluded.
- The reference folder contains the Clear Street source shell, styles, modules, fonts and baseline screenshots for traceability. Its replay server can retrieve missing reference media from the original public host; that reference is not an offline-complete video archive. The PLANKTON dist preview is self-contained.
- Generated media provenance and final properties are in docs/media.md. The private slot-generation manifest and raw masters mentioned there are intentionally not shipped.
- DELIVERY-MANIFEST.json records each included file's SHA-256 digest. The packaging tool can reproduce a ZIP after a new build.

## Rebuild this archive

Run tests and build first, then run `node tools/package-delivery.mjs --package --verify`. Python 3 is used only for ZIP creation/integrity checking. Set `--python /path/to/python` if it is not on PATH. The website itself requires only the Node workflow in START-HERE.md.
