import { getTranslations } from "next-intl/server";

const SECTIONS = [
  "types",
  "price",
  "deadlines",
  "conditions",
  "voids",
  "adjudication",
  "bands",
  "categories",
  "inclusion",
  "sources",
  "receipts",
] as const;

export const dynamic = "force-dynamic";

export default async function MethodologyPage() {
  const t = await getTranslations("method");
  return (
    <article className="max-w-[68ch]">
      <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.03em]">{t("title")}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{t("lead")}</p>
      {SECTIONS.map((id) => (
        <section key={id} className="mt-8">
          <h2 className="text-[16px] font-medium">{t(`${id}Title`)}</h2>
          {t(`${id}Body`)
            .split("\n\n")
            .map((paragraph) => (
              <p key={paragraph.slice(0, 48)} className="mt-2 text-[14px] leading-relaxed text-ink-2">
                {paragraph}
              </p>
            ))}
        </section>
      ))}
      <section className="mt-8 border-t border-dashed border-line pt-6">
        <h2 className="text-[16px] font-medium">{t("appealTitle")}</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{t("appealBody")}</p>
        <a
          href="https://github.com/joyboy-sats/walkback/issues"
          className="mt-3 inline-block w-fit text-[14px] underline-offset-4 hover:underline"
        >
          https://github.com/joyboy-sats/walkback/issues
        </a>
      </section>
    </article>
  );
}
