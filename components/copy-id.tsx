"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Full blob id and a copy button. There is no public URL for a Memory blob. */
export function CopyId({
  id,
  label,
  copyLabel,
  copiedLabel,
}: {
  id: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <span className="flex max-w-full flex-col gap-1">
      <span className="flex w-fit items-center gap-3">
        <span className="label">{label}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="w-fit"
          onClick={() => {
            void navigator.clipboard.writeText(id).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? copiedLabel : copyLabel}
        </Button>
      </span>
      <code className="mono break-all text-[11px] leading-relaxed text-ink-2">{id}</code>
    </span>
  );
}
