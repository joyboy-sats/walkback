"use client";

import { useTranslations } from "next-intl";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A plain-language term. The tooltip points at the methodology page. */
export function Term({ label, tip }: { label: string; tip: string }) {
  const t = useTranslations("nav");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="w-fit cursor-pointer border-b border-dotted border-ink-3 text-inherit"
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[32ch] px-3 py-2 text-left text-[12px] leading-relaxed">
        <p>{tip}</p>
        <a href="/methodology" className="mt-1.5 inline-block w-fit underline">
          {t("methodology")}
        </a>
      </TooltipContent>
    </Tooltip>
  );
}
