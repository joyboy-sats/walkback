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
    <span className="inline-flex max-w-full items-start gap-2">
      <span className="label shrink-0 pt-1">{label}</span>
      <code className="mono min-w-0 break-all text-[11px] leading-relaxed text-ink-2">{id}</code>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="w-fit shrink-0"
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
  );
}
