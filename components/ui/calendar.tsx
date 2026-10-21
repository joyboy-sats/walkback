"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
} from "react-day-picker"
import { enUS } from "date-fns/locale"
import { cn } from "cn"

/**
 * Month grid in English, on Walkback's dark surfaces.
 *
 * react-day-picker's default stylesheet is a light theme, so this component
 * does not import it. Layout and colour live in these class names. Locale is
 * pinned to en-US so a Chinese-locale browser still shows "October" and "Mo".
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  locale = enUS,
  weekStartsOn = 0,
  numerals = "latn",
  lang = "en-US",
  navLayout = "around",
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaults = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={locale}
      weekStartsOn={weekStartsOn}
      numerals={numerals}
      lang={lang}
      navLayout={navLayout}
      className={cn("p-2 text-ink", className)}
      classNames={{
        root: cn("relative", defaults.root),
        months: cn("relative flex", defaults.months),
        month: cn("relative w-fit", defaults.month),
        month_caption: cn(
          "flex h-9 items-center justify-center px-9",
          defaults.month_caption
        ),
        caption_label: cn(
          "text-[13px] font-medium text-ink",
          defaults.caption_label
        ),
        button_previous: cn(
          "absolute top-0 left-0 inline-flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink",
          defaults.button_previous
        ),
        button_next: cn(
          "absolute top-0 right-0 inline-flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink",
          defaults.button_next
        ),
        chevron: cn("size-4", defaults.chevron),
        month_grid: cn("border-collapse", defaults.month_grid),
        weekdays: cn(defaults.weekdays),
        weekday: cn(
          "size-9 p-0 text-center align-middle text-[11px] font-medium text-ink-2",
          defaults.weekday
        ),
        week: cn(defaults.week),
        weeks: cn(defaults.weeks),
        day: cn("size-9 p-0 text-center align-middle", defaults.day),
        day_button: cn(defaults.day_button),
        today: cn(defaults.today),
        selected: cn(defaults.selected),
        outside: cn(defaults.outside),
        disabled: cn(defaults.disabled),
        hidden: cn("invisible", defaults.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" />
          ) : orientation === "right" ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronRight className="size-4 rotate-90" />
          ),
        DayButton: CalendarDayButton,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  day: _day,
  modifiers,
  className,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-[13px] text-ink transition-colors hover:bg-surface-3",
        modifiers.outside && "text-ink-3",
        modifiers.today && !modifiers.selected && "ring-1 ring-accent ring-inset",
        modifiers.selected && "bg-accent font-medium text-white hover:bg-accent",
        modifiers.disabled && "opacity-40",
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
