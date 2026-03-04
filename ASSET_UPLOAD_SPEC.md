# CLI Asset Upload — API Spec

## Problem

`POST /api/cli` is JSON-only. Binary files (images, videos, PDFs) can't go through `write_file` because:
1. Content is a JSON string field — base64 bloats payload 33%
2. `write_file` saves to MongoDB only — no S3 upload
3. No S3 URL returned to CLI user

## Proposed Solution

Add a new command `upload_asset` to `/api/cli` that:
1. Accepts base64-encoded file content in JSON
2. Decodes and uploads to S3 (reusing `studio/core/assets.js` → `uploadFile`)
3. Saves file record to MongoDB with `assetMetadata` (s3Key, s3Url, mimeType, category)
4. Returns the S3 URL to the CLI

## API Contract

### Request
```json
POST /api/cli
Authorization: Bearer cm64_pat_xxx
Content-Type: application/json

{
  "command": "upload_asset",
  "project_id": "69a5...",
  "args": {
    "name": "hero-bg.jpg",
    "data": "<base64-encoded-file-content>",
    "folder": "images",
    "mime_type": "image/jpeg"
  }
}
```

### Args

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Filename with extension (e.g., `hero-bg.jpg`) |
| `data` | Yes | Base64-encoded file content |
| `folder` | No | S3 subfolder path (default: root) |
| `mime_type` | No | MIME type override. If omitted, detect from extension |

### Response (success)
```json
{
  "ok": true,
  "text": "Uploaded: hero-bg.jpg → https://bucket.s3.amazonaws.com/startup-1/images/hero-bg.jpg",
  "data": {
    "id": "file_id",
    "name": "hero-bg.jpg",
    "url": "https://bucket.s3.amazonaws.com/startup-1/images/hero-bg.jpg",
    "s3_key": "startup-1/images/hero-bg.jpg",
    "category": "image",
    "mime_type": "image/jpeg",
    "size": 145230,
    "hash": "abc123"
  }
}
```

### Response (error)
```json
{
  "ok": false,
  "error": "File too large. Maximum 10MB for CLI uploads."
}
```

## Server-Side Implementation

In `lib/cli/commands.js`, add:

```javascript
async upload_asset(args, auth) {
  const { name, data, folder, mime_type } = args;
  const proj = await requireProject(args, auth);

  if (!name) return fail('name is required');
  if (!data) return fail('data (base64) is required');

  // Decode base64
  const buffer = Buffer.from(data, 'base64');

  // Size limit (10MB for CLI)
  if (buffer.length > 10 * 1024 * 1024) {
    return fail('File too large. Maximum 10MB for CLI uploads.');
  }

  // Build a File-like object for uploadFile()
  const ext = name.split('.').pop().toLowerCase();
  const mimeType = mime_type || guessMime(ext);
  const file = new File([buffer], name, { type: mimeType });

  // Upload to S3 (reuse existing function)
  const s3Result = await uploadFile(file, proj.domain, folder || '');

  // Determine if text or binary for MongoDB content
  const isText = isTextAsset(ext);
  const content = isText ? buffer.toString('utf-8') : s3Result.url;

  // Save file record to MongoDB
  const savedFile = await saveFile({
    id: null,
    startupId: proj.projectId,
    name: name,
    class: 'asset',
    type: ext,
    content: content,
    path: folder ? `/${folder}` : '/',
    mimeType: mimeType,
    s3Key: s3Result.key,
    s3Url: s3Result.url,
    userId: auth.user._id?.toString(),
    isAIAgent: true,
    userName: 'CLI'
  });

  return {
    ok: true,
    text: `Uploaded: ${name} → ${s3Result.url}`,
    data: {
      id: savedFile.id,
      name: name,
      url: s3Result.url,
      s3_key: s3Result.key,
      category: detectAssetType(name, mimeType).category,
      mime_type: mimeType,
      size: buffer.length,
      hash: savedFile.hash
    }
  };
}
```

## Also Add: `list_assets`

Return all assets with their S3 URLs so the CLI user can reference them:

```json
{
  "command": "list_assets",
  "project_id": "69a5...",
  "args": {
    "folder": "images"
  }
}
```

Response:
```json
{
  "ok": true,
  "text": "3 assets\n  images/hero-bg.jpg  (image, 142KB)\n  images/logo.png  (image, 24KB)\n  docs/guide.pdf  (document, 1.2MB)",
  "data": {
    "assets": [
      {
        "name": "hero-bg.jpg",
        "url": "https://...",
        "s3_key": "startup-1/images/hero-bg.jpg",
        "category": "image",
        "size": 145230
      }
    ]
  }
}
```

## Size Limits

| Limit | Value | Reason |
|-------|-------|--------|
| Max file size | 10MB | Base64 in JSON = ~13.3MB payload. Reasonable for images. |
| Max payload | 15MB | Set in route.js body parser |
| Rate limit | Same 600/15min | Existing rate limit applies |

## MIME Detection Helper

```javascript
function guessMime(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ico: 'image/x-icon', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    pdf: 'application/pdf', json: 'application/json',
    css: 'text/css', html: 'text/html', txt: 'text/plain',
    md: 'text/markdown', csv: 'text/csv', xml: 'application/xml',
  };
  return map[ext] || 'application/octet-stream';
}
```

## CLI Side (already planned)

Once this API exists, the CLI command will be:

```bash
# Upload single asset
cm64 upload hero-bg.jpg -f ./hero-bg.jpg
cm64 upload logo.png -f ./logo.png --folder images

# Returns URL immediately
# → Uploaded: hero-bg.jpg → https://bucket.s3.../startup-1/hero-bg.jpg

# List assets
cm64 assets
cm64 assets --folder images
```

## Notes

- Reuse `uploadFile` from `studio/core/assets.js` — don't duplicate S3 logic
- Reuse `detectAssetType` from `studio/core/filemanager.js` for category detection
- Import in commands.js: `import { uploadFile } from '../../studio/core/assets.js'`
- The `saveFile` in filemanager.js already handles `s3Key`/`s3Url` in assetMetadata when provided
- Body size limit in route.js may need bumping from default to ~15MB
