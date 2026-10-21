"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { format } from "date-fns"
import { enUS } from "date-fns/locale"
import { CalendarIcon, X } from "lucide-react"
import { cn } from "cn"
import {
  clampTimePart,
  formatLocalDateTime,
  padTime,
  parseLocalDateTime,
  pushTimeDigit,
} from "@/lib/local-datetime"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * Date and time, displayed in English, stored as `YYYY-MM-DDTHH:mm`.
 *
 * The native datetime-local control follows the browser locale (a Chinese
 * browser shows 年/月/日). This picker does not. Clearing it sets the value
 * back to "" — the form's existing submit check still requires a time.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  disabled = false,
  className,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = parseLocalDateTime(value)
  const [hourText, setHourText] = useState(selected ? padTime(selected.getHours()) : "00")
  const [minuteText, setMinuteText] = useState(
    selected ? padTime(selected.getMinutes()) : "00"
  )
  const hourFocused = useRef(false)
  const minuteFocused = useRef(false)
  const hourRef = useRef(hourText)
  const minuteRef = useRef(minuteText)
  hourRef.current = hourText
  minuteRef.current = minuteText

  function setHour(next: string) {
    hourRef.current = next
    setHourText(next)
  }

  function setMinute(next: string) {
    minuteRef.current = next
    setMinuteText(next)
  }

  useEffect(() => {
    if (hourFocused.current || minuteFocused.current) return
    const next = parseLocalDateTime(value)
    setHour(next ? padTime(next.getHours()) : "00")
    setMinute(next ? padTime(next.getMinutes()) : "00")
  }, [value])

  function commit(date: Date, hours: number, minutes: number) {
    onChange(
      formatLocalDateTime(
        new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0)
      )
    )
  }

  function emitTime(nextHour: string, nextMinute: string) {
    const current = parseLocalDateTime(value)
    if (!current) return
    commit(current, clampTimePart(nextHour, 23), clampTimePart(nextMinute, 59))
  }

  function clear() {
    setHour("00")
    setMinute("00")
    onChange("")
  }

  const label = selected
    ? format(selected, "MMM d, yyyy, h:mm a", { locale: enUS })
    : "Select date and time"

  const timeReadout = format(
    new Date(2000, 0, 1, clampTimePart(hourText, 23), clampTimePart(minuteText, 59)),
    "h:mm a",
    { locale: enUS }
  )

  function onTimeKeyDown(
    e: KeyboardEvent<HTMLInputElement>,
    current: string,
    max: number,
    setText: (value: string) => void,
    commitPair: (next: string) => void
  ) {
    if (e.key.length === 1 && e.key >= "0" && e.key <= "9") {
      e.preventDefault()
      const next = pushTimeDigit(current, e.key, max)
      if (next === null) return
      setText(next)
      if (next.length === 2) commitPair(next)
      return
    }
    if (e.key === "Backspace") {
      e.preventDefault()
      setText(current.slice(0, -1))
    }
  }

  const fieldClass =
    "w-12 rounded-md border border-line bg-surface-1 px-1 py-1.5 text-center text-[13px] text-ink tnum outline-none transition-colors hover:border-line-strong focus:border-accent/60 disabled:opacity-50"

  return (
    <div className="relative">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            aria-required="true"
            className={cn(
              className,
              "relative flex items-center justify-between gap-2 pr-16 text-left",
              !selected && "text-ink-3"
            )}
          >
            <span className="truncate">{label}</span>
            <CalendarIcon className="pointer-events-none absolute right-3 size-3.5 text-ink-2" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px]" lang="en-US">
          <Calendar
            mode="single"
            selected={selected ?? undefined}
            defaultMonth={selected ?? new Date()}
            onSelect={(next) => {
              if (!next) return
              commit(next, clampTimePart(hourText, 23), clampTimePart(minuteText, 59))
            }}
          />
          <div className="flex items-center gap-2 border-t border-line px-3 py-3">
            <span className="label">Time</span>
            <input
              aria-label="Hour"
              inputMode="numeric"
              autoComplete="off"
              disabled={disabled}
              value={hourText}
              onFocus={(e) => {
                hourFocused.current = true
                e.currentTarget.select()
              }}
              onMouseUp={(e) => e.currentTarget.select()}
              onKeyDown={(e) =>
                onTimeKeyDown(e, hourRef.current, 23, setHour, (next) =>
                  emitTime(next, minuteRef.current)
                )
              }
              onBlur={() => {
                hourFocused.current = false
                const padded = padTime(clampTimePart(hourRef.current, 23))
                setHour(padded)
                emitTime(padded, minuteRef.current)
              }}
              className={fieldClass}
            />
            <span className="text-ink-3" aria-hidden="true">
              :
            </span>
            <input
              aria-label="Minute"
              inputMode="numeric"
              autoComplete="off"
              disabled={disabled}
              value={minuteText}
              onFocus={(e) => {
                minuteFocused.current = true
                e.currentTarget.select()
              }}
              onMouseUp={(e) => e.currentTarget.select()}
              onKeyDown={(e) =>
                onTimeKeyDown(e, minuteRef.current, 59, setMinute, (next) =>
                  emitTime(hourRef.current, next)
                )
              }
              onBlur={() => {
                minuteFocused.current = false
                const padded = padTime(clampTimePart(minuteRef.current, 59))
                setMinute(padded)
                emitTime(hourRef.current, padded)
              }}
              className={fieldClass}
            />
            <span className="ml-auto text-[12px] text-ink-2 tnum">{timeReadout}</span>
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <span className="text-[11px] text-ink-3">24-hour · English</span>
            <button
              type="button"
              onClick={clear}
              disabled={disabled || !value}
              className="text-[12px] text-ink-2 hover:text-ink disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {value && !disabled ? (
        <button
          type="button"
          aria-label="Clear date and time"
          onClick={clear}
          className="absolute top-1/2 right-8 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
