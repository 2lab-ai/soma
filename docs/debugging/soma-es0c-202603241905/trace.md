# Bug Trace: soma-es0c — document handler should accept image files as documents

## AS-IS
Sending an image as a Telegram document (for example `.png`) returns `❌ Unsupported file type: .png`.

## TO-BE
Telegram document uploads should accept `.png`, `.jpg`, `.jpeg`, `.webp`, and `.svg`, and route them through image analysis instead of text extraction.

## Phase 1: Heuristic Top-3

### Hypothesis 1: `handleDocument()` rejects image extensions before download
- `src/handlers/document.ts:692-711` computes `isPdf`, `isText`, and `isArchiveFile`, then rejects everything else.
- Image extensions and image MIME types were not part of this gate.
- Result: `.png` sent as a document is rejected before any downstream processing. Confirmed.

### Hypothesis 2: media-group document batches still assume every file is text/PDF
- `src/handlers/document.ts:591-646` previously iterated every buffered path through `extractText()`.
- `src/handlers/document.ts:114-136` only extracts PDF/text and throws for image files.
- Result: even if single-document support were added, document albums containing images would still fail. Confirmed.

### Hypothesis 3: iPhone photo attachments work because they do not go through `handleDocument()`
- `src/handlers/photo.ts:137-239` handles Telegram `photo` messages separately.
- `src/handlers/photo.ts:215-217` sends downloaded photos directly to `processPhotos()`.
- Result: the user-observed difference is real: `photo` uploads already worked, `document` uploads did not. Confirmed.

## Red
- `src/handlers/document.test.ts:97-103` added `BUG soma-es0c: isImageDocumentType accepts requested image document formats`.
- `src/handlers/document.test.ts:106-143` added `BUG soma-es0c: handleDocument accepts png image documents`.
- Initial RED proof: `bun test src/handlers/document.test.ts --test-name-pattern 'soma-es0c'` failed because `isImageDocumentType` was not exported from `src/handlers/document.ts`.

## Fix
- `src/handlers/document.ts:47-66` adds image extension/MIME allowlists and `isImageDocumentType()`.
- `src/handlers/document.ts:152-199` adds `processImageDocuments()` for document-uploaded images.
- `src/handlers/document.ts:201-263` adds `processMixedDocumentInputs()` for mixed text/image document batches.
- `src/handlers/document.ts:600-646` splits buffered document paths into image vs text paths before processing.
- `src/handlers/document.ts:697-710` extends the supported-type gate to include image documents.
- `src/handlers/document.ts:756-767` routes single image documents to `processImageDocuments()`.

## Green
- `bun test src/handlers/document.test.ts --test-name-pattern 'soma-es0c'` → 2 pass, 0 fail.
- `bun run typecheck` → pass.
- `bun test` → 608 pass, 0 fail.
- `make lint` → pass with existing warnings only.
