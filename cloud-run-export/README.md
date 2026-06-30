# Create-your-jam Cloud Run Exporter

This is a first-pass MP4 renderer for Google Cloud Run.

## What it does

- Receives arrangement data from `index.html`.
- Captures low-res frames with Chromium.
- Combines frames with audio using FFmpeg.
- Returns an MP4 download.

## Deploy

From this folder:

```sh
gcloud run deploy create-your-jam-exporter \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900
```

After deployment, copy the Cloud Run service URL. In the app, tap **MP4** once and paste the URL when asked. The app will remember it in the browser.

## Notes

- Keep exports low-res for speed.
- Clips uploaded only as local browser files cannot be rendered by Cloud Run. Upload them to the shared library first so the renderer can access their public URL.
- This version returns a download directly. Email delivery can be added after this render path works reliably.
