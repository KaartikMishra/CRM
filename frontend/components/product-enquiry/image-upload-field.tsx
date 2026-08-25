'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { AlertCircle, ImagePlus, Loader2, RotateCcw, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Product image upload.
 *
 * The file goes to the Next.js proxy, which attaches the session token and
 * forwards to the Express upload endpoint; that endpoint talks to Cloudinary
 * and records a MediaAsset. The browser never holds a Cloudinary credential —
 * it only ever receives back an asset id and a public URL.
 *
 * The caller keeps the asset id and threads it through as `imageAssetId`, which
 * is what the enquiry and vendor-response contracts already expect.
 */

type UploadState =
  | { status: 'empty' }
  | { status: 'uploading'; preview: string }
  | { status: 'ready'; preview: string; assetId: string }
  | { status: 'error'; message: string; retry: File };

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

export function ImageUploadField({
  value,
  onChange,
  label = 'Product image',
  className,
}: {
  /** Asset id currently attached, if any. */
  value?: string | null;
  onChange: (assetId: string | null) => void;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ status: 'empty' });
  const [dragging, setDragging] = useState(false);

  async function send(file: File) {
    const preview = URL.createObjectURL(file);
    setState({ status: 'uploading', preview });

    try {
      const form = new FormData();
      form.append('file', file);

      const response = await fetch('/api/proxy/uploads', { method: 'POST', body: form });
      const body = await response.json();

      if (!response.ok || !body.success) {
        // The API already phrases these for the person reading them.
        setState({
          status: 'error',
          message: body.message ?? 'Upload failed. Please try again.',
          retry: file,
        });
        onChange(null);
        return;
      }

      setState({ status: 'ready', preview: body.data.asset.secureUrl, assetId: body.data.asset.id });
      onChange(body.data.asset.id);
      URL.revokeObjectURL(preview);
    } catch {
      setState({ status: 'error', message: 'Upload failed. Please try again.', retry: file });
      onChange(null);
    }
  }

  function clear() {
    setState({ status: 'empty' });
    onChange(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  const busy = state.status === 'uploading';
  const showing = state.status === 'uploading' || state.status === 'ready' ? state.preview : null;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-ink-2">{label}</span>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void send(file);
        }}
        className={cn(
          'relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border bg-surface-2 transition-colors',
          dragging ? 'border-accent bg-brass-soft' : 'border-dashed border-line-2',
          state.status === 'error' && 'border-critical/40 bg-critical-soft',
        )}
      >
        {showing ? (
          <Image
            src={showing}
            alt=""
            fill
            sizes="160px"
            unoptimized
            className={cn('object-cover', busy && 'opacity-40')}
          />
        ) : null}

        {busy && (
          <span className="relative flex flex-col items-center gap-1.5 text-xs text-ink-2">
            <Loader2 className="size-5 animate-spin" />
            Uploading…
          </span>
        )}

        {state.status === 'empty' && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center transition-colors hover:bg-surface-3"
          >
            <ImagePlus className="size-5 text-faint" aria-hidden />
            <span className="text-xs text-muted">Upload product image</span>
            <span className="text-[10px] text-faint">or drop a file</span>
          </button>
        )}

        {state.status === 'error' && (
          <span className="relative flex flex-col items-center gap-1.5 px-3 text-center">
            <AlertCircle className="size-5 text-critical" aria-hidden />
            <span className="text-xs text-critical">{state.message}</span>
          </span>
        )}

        {state.status === 'ready' && (
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label="Replace image"
              className="rounded-sm bg-surface/90 p-1 text-ink-2 shadow-card transition-colors hover:text-ink"
            >
              <Upload className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={clear}
              aria-label="Remove image"
              className="rounded-sm bg-surface/90 p-1 text-ink-2 shadow-card transition-colors hover:text-critical"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {state.status === 'error' && (
        <button
          type="button"
          onClick={() => void send(state.retry)}
          className="flex items-center justify-center gap-1.5 text-xs text-accent hover:underline"
        >
          <RotateCcw className="size-3" />
          Try again
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />

      {state.status === 'empty' && (
        <p className="text-xs text-muted">JPEG, PNG, WebP or GIF · up to 5 MB</p>
      )}
    </div>
  );
}
