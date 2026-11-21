/**
 * ISF CMS Tiptap Editor — client-side bundle entry point.
 * Compiled by esbuild → public/js/editor.bundle.js
 *
 * Exports the Tiptap editor class and all required extensions.
 * The actual editor initialisation and toolbar wiring happen in
 * the inline <script> block of cms/article-edit.njk, which has
 * access to server-rendered variables (csrfToken, article data, etc.)
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';

export { Editor, StarterKit, Link, Underline, Placeholder, TextAlign, Image };

// ---------------------------------------------------------------------------
// Image upload helper — called from the editor toolbar
// ---------------------------------------------------------------------------

/**
 * Open a file picker, upload the selected image to the backend,
 * and insert it at the current editor cursor position.
 *
 * @param editor     The active Tiptap Editor instance
 * @param csrfToken  CSRF token from the page (passed from Nunjucks template)
 * @param onStatus   Optional callback to report status messages to the UI
 */
export async function uploadAndInsertImage(
  editor: InstanceType<typeof Editor>,
  csrfToken: string,
  onStatus?: (msg: string, isError?: boolean) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(); return; }

      // Client-side size guard (3 MB)
      if (file.size > 3 * 1024 * 1024) {
        onStatus?.('Ukuran file melebihi 3 MB.', true);
        resolve();
        return;
      }

      onStatus?.('Mengunggah gambar…');

      try {
        const formData = new FormData();
        formData.append('image', file);

        const response = await fetch('/api/v1/cms/upload-image', {
          method: 'POST',
          headers: {
            // CSRF token header expected by csrf-csrf
            'x-csrf-token': csrfToken,
          },
          body: formData,
          credentials: 'same-origin',
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const msg = (body as { error?: string }).error ?? `Upload gagal (${response.status})`;
          onStatus?.(msg, true);
          resolve();
          return;
        }

        const data = (await response.json()) as { url: string; key: string };

        // Insert image at current cursor position
        editor
          .chain()
          .focus()
          .setImage({ src: data.url, alt: file.name })
          .run();

        onStatus?.('Gambar berhasil diunggah.');
      } catch (err) {
        console.error('[ISFEditor] Image upload error:', err);
        onStatus?.('Gagal mengunggah gambar. Periksa koneksi dan coba lagi.', true);
      }

      resolve();
    };

    // Trigger file picker
    input.click();
  });
}

/**
 * Upload a cover image and return the public URL.
 * Does not insert into the editor — just uploads and returns the URL.
 *
 * @param file       The File object from a file input
 * @param csrfToken  CSRF token from the page
 * @param onStatus   Optional status callback
 */
export async function uploadCoverImage(
  file: File,
  csrfToken: string,
  onStatus?: (msg: string, isError?: boolean) => void,
): Promise<{ url: string; key: string } | null> {
  if (file.size > 3 * 1024 * 1024) {
    onStatus?.('Ukuran file melebihi 3 MB.', true);
    return null;
  }

  onStatus?.('Mengunggah gambar sampul…');

  try {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/v1/cms/upload-image', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: formData,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const msg = (body as { error?: string }).error ?? `Upload gagal (${response.status})`;
      onStatus?.(msg, true);
      return null;
    }

    const data = (await response.json()) as { url: string; key: string };
    onStatus?.('Gambar sampul berhasil diunggah.');
    return data;
  } catch (err) {
    console.error('[ISFEditor] Cover image upload error:', err);
    onStatus?.('Gagal mengunggah gambar sampul. Periksa koneksi dan coba lagi.', true);
    return null;
  }
}
