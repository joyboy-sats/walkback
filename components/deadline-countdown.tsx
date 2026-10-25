"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/** Time left until a pending claim's deadline. No price, and no network call. */
export function DeadlineCountdown({ deadline }: { deadline: string }) {
  const t = useTranslations("feed");
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (now === null) return <span>{t("pendingOpen")}</span>;
  const end = Date.parse(deadline);
  if (Number.isNaN(end)) return <span>{t("pendingOpen")}</span>;
  const ms = end - now;
  if (ms <= 0) return <span>{t("countdownPast")}</span>;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return <span className="tnum">{t("countdown", { days, hours })}</span>;
}
